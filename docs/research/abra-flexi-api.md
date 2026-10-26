# ABRA Flexi REST API — ověřený implementační podklad

Stav ověření: 2026-10-26

Tento dokument shrnuje vlastnosti oficiálního REST API ABRA Flexi, které jsou
závazné pro návrh MCP serveru. Primárním rozcestníkem je [oficiální kolekce
REST API dokumentace](https://podpora.flexibee.eu/en/collections/2592813-rest-api-documentation).
Starší [API rozcestník](https://www.flexibee.eu/api/dokumentace) zůstává užitečný,
ale jednotlivá pravidla níže byla ověřena v aktuální podpoře ABRA.

## 1. Přístup, licence a limity

- Přístup k REST API je samostatně licencovaná služba.
- ABRA doporučuje samostatného API uživatele pro každou integraci a omezení
  jeho role pouze na potřebné firmy a evidence.
- Aktuálně zveřejněné denní limity jsou 5 000 požadavků pro Basic, 10 000 pro
  Business a 20 000 pro Premium; po vyčerpání API vrací HTTP 429. Limity a
  obchodní podmínky se musí před nasazením znovu ověřit.
- MCP server proto musí stránkovat, používat `detail=custom`, cache s tenantovým
  namespace a Changes API místo pravidelných plných exportů.

Zdroje:

- [Licencování přístupu k API](https://podpora.flexibee.eu/cs/articles/10097467-licencovani-pristupu-k-api)
- [Úvod do REST API a denní limity](https://podpora.flexibee.eu/cs/articles/3638736-jak-zacit-s-api-flexi-1-6-uvod-do-rest-api)

## 2. Autentizace

ABRA podporuje:

- HTTP Basic autentizaci;
- JSON login přes `POST /login-logout/login.json`;
- session token přes cookie nebo hlavičku `X-authSessionId`;
- 2FA; SAML/OpenID pouze v některých lokálních instalacích a licencích.

Session token lze poslat také v query parametru, ale ABRA výslovně upozorňuje,
že se tím zapíše do serverových logů. MCP adaptér proto zakazuje credentials,
OTP i session tokeny v URL. Basic auth smí být použit jen přes ověřené HTTPS;
privátní CA se řeší explicitním trust store, nikoli vypnutím TLS validace.

Zdroj: [Authentication](https://podpora.flexibee.eu/en/articles/4713880-authentication)

## 3. URL, firmy a formáty

Základní tvar adresy je:

```text
/c/{company-identifier}/{evidence}/{record-identifier}.{format}
```

Identifikátor firmy není stabilní globální business ID. Po obnově firmy ze
zálohy může být jiný. V naší konfiguraci proto používáme vlastní stabilní
`connectionId`, které se serverově mapuje na konkrétní origin a aktuální Flexi
company identifier.

XML a JSON podporují čtení i zápis. Formát odpovědi určuje přípona nebo `Accept`,
formát vstupu primárně `Content-Type`. MCP klient nebude volit formát ani URL;
to je interní odpovědnost Flexi adaptéru. MVP používá JSON codec, ale zachovává
Flexi `winstrom` envelope a testovací fixtures pro ekvivalentní XML reprezentaci.

Zdroje:

- [Building URLs](https://podpora.flexibee.eu/en/articles/4713911-building-urls)
- [Supported Formats](https://podpora.flexibee.eu/en/articles/4719998-supported-formats)
- [Company identifier](https://podpora.flexibee.eu/en/articles/4425606-company-identifier-company-id-and-list-of-created-companies-using-the-api)

## 4. Runtime discovery a schéma

Schéma API není univerzální. Závisí na konkrétní firmě, legislativě, typu
organizace, účetním režimu, licenci a oprávnění přihlášeného uživatele.

Relevantní endpointy:

```text
GET /c/{company}/evidence-list.json
GET /c/{company}/{evidence}/properties.json
GET /c/{company}/{evidence}/relations.json
GET /c/{company}/{evidence}/schema-export.xsd
GET /c/{company}/{evidence}/schema-import.xsd
```

`evidence-list` obsahuje mimo jiné `evidencePath`, `importStatus` a informaci,
zda evidence podporuje externí identifikátory. Zápis je bezpečné nabízet jen pro
explicitně povolené evidence s `importStatus=SUPPORTED`.

XSD je užitečný snapshot, ale ABRA výslovně uvádí, že nemusí pokrýt všechny
reálně vracené tvary. Nesmí být jediným validátorem. Pro zápisy kombinujeme:

1. statickou doménovou Zod validaci;
2. tenantový allowlist;
3. aktuální `properties` a import XSD;
4. Flexi `dry-run=true`.

Zdroje:

- [XML Schema (XSD)](https://podpora.flexibee.eu/en/articles/4729202-xml-schema-xsd)
- [Importing records via API](https://podpora.flexibee.eu/en/articles/3421990-importing-records-via-api)

## 5. Čtení, detail a stránkování

- Seznam má výchozí `detail=summary`, detail jednoho záznamu `detail=full`.
- Preferujeme `detail=custom:...`; šetří dotazy, paměť i množství dat předaných
  modelu.
- Neznámé properties v `detail=custom` mohou být ignorovány. Požadovaná pole
  proto validujeme proti aktuálnímu `properties` snapshotu a u povinných polí
  kontrolujeme jejich přítomnost i ve výsledku.
- Stránkování používá `limit` a `start`; default je 20. `limit=0` znamená
  neomezený export a z MCP vrstvy bude vždy zakázán.
- `add-row-count=true` přidává celkový počet, ale může znamenat další databázový
  dotaz. Použije se pouze na první stránce nebo pro explicitní count operaci.
- Vnější MCP cursor bude podepsaný a sváže tenant, connection, evidence, filtr,
  pole, řazení a offset. Model nebude přímo ovládat `start`.

Zdroje:

- [Levels of Detail](https://podpora.flexibee.eu/en/articles/4722190-levels-of-detail)
- [Pagination](https://podpora.flexibee.eu/en/articles/4722193-pagination)
- [Performance Optimization](https://podpora.flexibee.eu/en/articles/4720082-performance-optimization)

## 6. Filtry

Flexi má bohatý textový filtrovací jazyk: relační operátory, `like`, `between`,
`in`, stromové operátory, `and/or/not`, funkce jako `now()` a libovolně hluboké
1:1 relační cesty.

MCP nebude přijímat raw filter string. Přijme omezený typovaný AST, například:

```json
{
  "all": [
    { "field": "datVyst", "op": "gte", "value": "2026-01-01" },
    { "field": "stavUhrK", "op": "eq", "value": "stavUhr.neuhrazeno" }
  ]
}
```

Compiler ověří field proti `properties`, typ hodnoty, povolený operátor, počet
podmínek a maximální hloubku relace. Hodnoty escapuje jediná interní funkce.
Placeholdery `me()`, `now()` a uložené uživatelské filtry nebudou v prvním MVP.

Zdroj: [Filtering records](https://podpora.flexibee.eu/en/articles/4722195-filtering-records)

## 7. Identifikátory a idempotence

Flexi rozlišuje interní číselná ID, `code:...`, externí `ext:SYSTEM:...` a další
varianty. Kritická vlastnost: při zápisu přes nečíselný identifikátor, který
neexistuje, může Flexi vytvořit nový záznam; existující záznam naopak aktualizuje.

Z toho plyne:

- každý create dostane serverem generované externí ID;
- update nejprve jednoznačně načte současný záznam;
- žádné fuzzy hledání cíle zápisu;
- idempotency ledger je persistentní a váže tenant, connection, tool, payload
  hash a externí ID;
- u položkových dokladů mají externí ID také položky, jinak opakovaný import
  může vytvářet duplicity;
- `removeAll=true` nebude obecně dostupná volba MCP toolu.

Zdroje:

- [Record Identifiers](https://podpora.flexibee.eu/en/articles/4725798-record-identifiers)
- [API FAQ — doporučení pro import](https://podpora.flexibee.eu/en/articles/4786953-frequently-asked-questions-about-the-api)
- [Assigning External ID in JSON](https://podpora.flexibee.eu/en/articles/3422368-assigning-external-id-in-json-format)

## 8. Zápisy, dry-run a transakce

ABRA nerozlišuje význam POST a PUT pouze podle metody; záleží na URL a payloadu.
MCP proto nevystaví obecnou metodu, cestu ani payload.

Před ostrým zápisem použijeme `?dry-run=true`. Flexi provede validace a vrátí
výslednou reprezentaci bez uložení. Číslo dokladu přidělené během dry-run je ale
jen dočasné a ostrý zápis může dostat jiné.

Výchozí import je atomická databázová transakce. `atomic=false` může vytvořit
částečně úspěšnou dávku a oficiální dokumentace varuje před nekonzistencí. MCP
jej proto nepovolí.

Zdroje:

- [Supported HTTP Operations](https://podpora.flexibee.eu/en/articles/4720093-supported-http-operations)
- [Test Save (Dry Run)](https://podpora.flexibee.eu/en/articles/4720123-test-save-dry-run)
- [Transakční zpracování](https://podpora.flexibee.eu/cs/articles/4726125-transakcni-zpracovani)

## 9. Chyby, timeouty a retry politika

Flexi používá HTTP status a většinou také strojově čitelné XML/JSON chyby.
Významné stavy jsou 400, 401, 402, 403, 404, 405, 406, 409, 429, 500 a 503.
Pro 409 a 503 dokumentace zakazuje okamžité opakování.

HTTP 504 je zvláštní případ: proxy přestala čekat, ale operace ve Flexi může dál
běžet a úspěšně skončit. Stav zápisu se proto označí `unknown`, nikdy se slepě
neopakuje a spustí se reconciliation podle externího ID a aktuálních dat.

Interní normalizace výsledku rozlišuje:

```text
not_applied | applied | unknown
```

Zdroje:

- [Error Handling](https://podpora.flexibee.eu/en/articles/4720060-error-handling)
- [Chování při HTTP 504](https://podpora.flexibee.eu/cs/articles/5127229-rest-api-vraci-timeout-proces-na-pozadi-stale-bezi-nebo-je-nutne-pozadavek-opakovat)

## 10. Changes API, webhooky a audit

Changes API poskytuje monotónně rostoucí `globalVersion`; hodnoty mohou mít
mezery, ale pořadí je jednoznačné. Je vhodné pro cursor-based synchronizaci.
Zapnutí či vypnutí Changes API mění databázovou strukturu a vyžaduje exkluzivní
lock. MCP server jej proto nebude automaticky aktivovat.

Webhooky vyžadují aktivní Changes API, mohou přijít opožděně nebo duplicitně a
musí se deduplikovat podle `globalVersion`. Handler má rychle uložit událost a
asynchronně ji zpracovat.

ABRA neloguje jednotlivé REST requesty. Žurnál eviduje datové změny, nikoli
úplný přístupový audit. MCP proto potřebuje vlastní append-only audit bez hesel,
tokenů a raw účetních payloadů.

Zdroje:

- [Changes API](https://podpora.flexibee.eu/en/articles/4744362-changes-api)
- [Web Hooks](https://podpora.flexibee.eu/en/articles/4744379-web-hooks)
- [Changelog and Access Logging](https://podpora.flexibee.eu/en/articles/3422275-changelog-and-access-logging-via-rest-api)

## 11. Rozhodnutí pro MCP MVP

1. Read-only jako výchozí a první produkční režim.
2. Žádný obecný REST, URL, `/query`, action nebo raw filter passthrough.
3. Tenant a firma se určují serverovou konfigurací/identitou, ne modelem.
4. Evidence a pole se validují proti tenantovému runtime discovery snapshotu.
5. Pevné horní limity stránek a odpovědí; nikdy `limit=0`.
6. Pouze `detail=custom` s explicitním field allowlistem.
7. Budoucí zápisy výhradně `prepare -> dry-run -> confirm -> commit -> verify`.
8. Persistentní idempotence a reconciliation pro neurčité výsledky.
9. Vlastní audit a metriky API quota.
10. Changes API pouze po explicitním administrátorském zapnutí ve Flexi.

