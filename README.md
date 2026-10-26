# MCP pro ABRA Flexi

TypeScript MCP server pro čtení účetních dat z více firem a serverů ABRA Flexi a načítání
citovaných pasáží z ověřeného korpusu českých účetních a daňových předpisů.

Server používá **lokální stdio**. Výchozí provoz je read-only; verze 0.4 přidává řízené opravy existujících přijatých faktur s náhledem, podpisem a ověřením výsledku. Obsahuje skutečný MCP server,
Flexi klienta, runtime validaci schématu, podepsané stránkování, audit a legislativní
retrieval. Právní korpus zatím není naplněný: právní nástroje vracejí `not_ready`
a odkazy na oficiální zdroje. Žádné vzorové texty se nevydávají za platné právo.

Verze 0.2 přidává režim `FLEXI_ALLOWED_EVIDENCES=*`: evidence a pole se objevují
z metadat konkrétní firmy a API role. Zahrnuje dodavatele, DIČ, DPH, účty,
položky dokladů, účetní deník a číselníky. Dřívější seznam dvanácti polí faktur
se používá jen ve výchozím omezeném režimu. [Rozsah přístupu](docs/api-access.md)
rozlišuje metadata dostupných evidencí a skutečně provedené živé testy.

## Řízené opravy faktur (0.4)

Volitelná per-target `writePolicy` přidává `flexi_invoice_update_prepare`,
`flexi_invoice_update_status` a `flexi_invoice_update_commit`. Vícefiremní
instalace se zapnutým writerem nabízí 16 nástrojů. Výchozí režim zůstává pouze
pro čtení. Uložení se týká přesné existující přijaté faktury a jejích existujících
položek; nevystavuje vytvoření, mazání, platby ani obecné API akce.

Náhled obsahuje skutečný vypočtený dry-run a jeho změny. Lokální operátor podepíše
přesný intent mimo MCP. Commit používá update-only import s optimistickým zámkem,
trvale spotřebuje oprávnění před PUT a následně ověří fakturu, položky i požadované
řádky účetního deníku. Neurčitý výsledek blokuje další pokusy stejného dokladu.
[Postup a schvalování](docs/invoice-updates.md), [ověřený API kontrakt](docs/research/invoice-write-contract.md).

## Více serverů a firem (0.3)

Jeden proces podporuje více nakonfigurovaných API serverů a firem. Každý cíl má
samostatného klienta a cache. Discovery ověří přesné `dbNazev`, přístupnost a stav
`ESTABLISHED`; nově objevená firma nedostane automaticky povolený datový přístup.

Konfigurační JSON má formát [connections.example.json](config/connections.example.json).
Hesla jsou v proměnných prostředí odkazovaných credential profilem. Aktivace:

```dotenv
FLEXI_CONFIG_PATH=/absolute/path/to/connections.json
# Odstraňte aktivní FLEXI_BASE_URL, FLEXI_COMPANY a FLEXI_CONNECTION_NAME.
# FLEXI_USERNAME/FLEXI_PASSWORD mohou zůstat jako env odkazy credential profilu.
```

`flexi_server_list` vypíše servery, `flexi_company_list` dostupné firmy na zvoleném
serveru a profilu, `flexi_target_list` povolené cíle. Discovery firem i seznam
cílů podporují `pageSize` a `nextCursor`. Datové nástroje mají argument `target`:

```json
{"target":"primary/production","evidence":"faktura-prijata","fields":["id","kod","nazFirmy"],"pageSize":1}
```

Při více cílech je `target` povinný, i když je dostupný pouze jeden z nich.
Neexistuje sdílená aktuální firma. Výsledek i audit nesou původ serveru a firmy;
cursory se nedají přenášet mezi cíli. Limity HTTP požadavků se sdílejí podle
kanonického originu napříč firmami a credential profily. Globální `server_info`
ukazuje nejvýše prvních 20 cílů a jejich celkový počet; úplný seznam je stránkovaný.

Bez `FLEXI_CONFIG_PATH` zůstává podporovaná původní konfigurace jedné firmy.
Ve vícefiremním režimu je 13 čtecích nástrojů; zapnuté opravy faktur přidávají tři další.
Podrobnosti: [architektura více firem](docs/multi-server-companies.md).

## Spuštění

Node.js 24+ a npm. Závislosti jsou připnuté v `package-lock.json`; install scripts
nejsou potřebné.

```sh
npm ci --ignore-scripts
npm run check
cp .env.example .env
chmod 600 .env
```

Vyplňte `.env` lokálně. Do MCP argumentů ani chatu nevkládejte heslo. Použijte
samostatného Flexi API uživatele s právem čtení pouze zvolené firmy a evidencí.

```sh
node --env-file=.env dist/index.js
```

`stdout` obsahuje výhradně MCP komunikaci. Samostatné spuštění proto čeká na
MCP klienta. Pro vývoj funguje také `node --env-file=.env src/index.ts`.

Server podporuje MCP revizi `2026-07-28` i handshake starších klientů přes
oficiální TypeScript SDK v2. Aktuálně je připnutá ověřená lokálně dostupná verze
SDK 2.3.1; aktualizace na novější verze musí projít stejnými integračními testy.

## Zapojení klienta

Obecná konfigurace MCP hosta:

```json
{
  "mcpServers": {
    "abra_flexi": {
      "command": "/absolute/path/to/node",
      "args": [
        "--env-file=/absolute/path/to/mcp-flexibee/.env",
        "/absolute/path/to/mcp-flexibee/dist/index.js"
      ]
    }
  }
}
```

Použijte skutečnou absolutní cestu k Node 24+. `MCP_AUDIT_PATH` nastavte absolutně
a pro každou instanci zvlášť. Konfigurace MCP hosta se tímto projektem automaticky
nemění.

### ChatGPT desktop a iPhone

ChatGPT desktop sdílí lokální MCP konfiguraci s Codex CLI. Po buildu lze server
zaregistrovat pro tento Mac (použijte skutečnou absolutní cestu k Node 24+):

```sh
codex mcp add abra_flexi -- /opt/homebrew/bin/node /absolute/path/to/mcp-flexibee/scripts/start-chatgpt.mjs
```

Launcher načítá zdejší `.env` nezávisle na pracovním adresáři hosta. Každé spuštění
má vlastní auditní řetězec v `.state/chatgpt/audit-<uuid>.jsonl`; pro tento launcher
se `MCP_AUDIT_PATH` z `.env` přepisuje. Po instalaci načtěte server v nastavení
MCP aplikace a v nové konverzaci zkontrolujte `/mcp` a zavolejte `server_info`.
Účetní nástroje vyžadují buď legacy přístupové proměnné, nebo `FLEXI_CONFIG_PATH` a credential proměnné odkazované konfigurací.

Na iPhonu lze lokální server používat přes připojený Mac: v desktop aplikaci
Settings → Connections → Control this Mac nastavte připojení a spárujte telefon
QR kódem. V iOS aplikaci otevřete Codex (případně Remote) a zvolte tento Mac.
Mac musí být vzhůru a online. Dostupnost závisí na účtu a pravidlech workspace.
Samostatné používání bez Macu vyžaduje další implementaci vzdáleného MCP serveru
a připojení jako plugin; tato verze poskytuje pouze lokální stdio.

Oficiální návod: [MCP](https://learn.chatgpt.com/docs/extend/mcp) a
[mobilní připojení](https://learn.chatgpt.com/docs/mobile).

## Nástroje

| Nástroj | Účel |
|---|---|
| `server_info` | Připojená firma, povolené evidence, limity a připravenost korpusu |
| `flexi_evidence_list` | Objevení evidencí, jejich názvů a přístupnosti; režim `*` |
| `flexi_schema_get` | Pole a typy; v režimu `*` také popisky, cíle referencí a hodnoty výčtů |
| `flexi_relations_get` | Dostupné kolekce navázaných záznamů a jejich cílové evidence; režim `*` |
| `flexi_relation_list` | Stránkované položky a jiné vazby konkrétního dokladu; režim `*` |
| `flexi_record_list` | Omezená stránka s vybranými poli a typovanými AND filtry |
| `flexi_record_get` | Detail podle přesného číselného ID |
| `czlaw_status` | Verze korpusu, pokrytí, čerstvost a oficiální zdroje |
| `czlaw_search` | Citované pasáže podle data, režimu a tématu |
| `czlaw_provision_get` | Konkrétní ustanovení podle ID a rozhodného data |

Při chybějící konfiguraci Flexi se tři `flexi_*` nástroje vůbec neregistrují.
Resources: `flexi://capabilities`, `czlaw://status`. Prompt `accounting_review`
vede model k ověření režimu, potřebných dat, rozhodných dat a právních citací.

Příklad `flexi_record_list`:

```json
{
  "evidence": "faktura-vydana",
  "fields": ["id", "kod", "datVyst", "datSplat", "sumCelkem", "stavUhrK"],
  "pageSize": 20,
  "filters": [{"field": "datVyst", "op": "gte", "value": "2026-01-01"}]
}
```

Další stránka používá stejný dotaz a vrácený `nextCursor`. Cursor platí 15 minut,
je vázaný na proces, firmu a přesný dotaz. Data jsou řazena podle ID; offsetové
stránkování nad měnící se databází není konzistentní snapshot celé evidence.

Veškeré filter hodnoty jsou řetězce, včetně přesných desetinných částek.
V aktuální verzi jsou podporovány konzervativní operátory `eq`, `ne`, `gt`,
`gte`, `lt`, `lte`, `contains`, maximálně deset AND podmínek. Uvozovky a některé
speciální znaky se odmítají. Složitější filtry přidáme až s kontraktními testy.

## Datová politika a provoz

Jedna instance má jeden pevný HTTPS origin a jednu firmu. Tool argumenty nemohou
změnit host, firmu, metodu ani cestu. Klient používá jen explicitní čtecí cesty,
protože některé jiné Flexi GET endpointy mohou provádět změny. Redirecty se
odmítají a TLS ověření zůstává zapnuté. Vlastní CA lze dodat standardním
`NODE_EXTRA_CA_CERTS` při startu.

Výchozí omezená konfigurace povoluje faktury a volitelně adresář/ceník.
Režim `FLEXI_ALLOWED_EVIDENCES=*` povoluje evidence zveřejněné přes
`evidence-list.json` s `evidenceAccess=true` a pole z jejich `properties.json`.
Credential úložiště, certifikáty a spustitelná konfigurace zůstávají blokované.
API odpověď se znovu ořeže na požadovaná pole. Referenční pole navíc vracejí
`@showAs` a `@internalId`, nikdy upstream URL `@ref`. Relace 1:N se čtou odděleně
přes `flexi_relation_list` s vlastním stránkováním. Osobní a firemní údaje v povolených
polích zůstávají citlivými daty; tento server je neoznačuje za anonymizovaná.

Limity: nejvýše 100 záznamů na stránku, 200 polí v režimu `*` (20 v omezeném
režimu), offset 10 000, 1 MiB upstream odpovědi
a 512 KiB MCP výstupu, 15 sekund na celý HTTP stream, čtyři souběžná volání a
výchozích 60 lokálních volání za minutu. Jde o lokální ochranu, nikoli přesnou
evidenci denní licence Flexi. Automatické retry není implementované.

Audit zapisuje ID požadavku, čas, operaci, označení připojení a výsledek. Nezapisuje
argumenty, hesla, obsah dokladů ani raw upstream chyby. Je chráněn právy 0600,
řetězen SHA-256 a po každém záznamu synchronizován na disk. Při selhání auditu se
operace zablokuje nebo její výsledek nevydá. Lokální hash chain neposkytuje
ochranu proti administrátorovi, který přepíše celý soubor.

Pro jeden auditní soubor smí běžet jediný writer. Exkluzivní soubor `.lock`
zabrání souběžným startům. Po pádu procesu může zůstat; odstranit jej smí správce
až po ověření, že všechny procesy používající audit skončily. Server sám nikdy
neodstraňuje údajně staré zámky. Audit má limit 8 MiB; rotace se nyní provádí
offline při vypnutém serveru zachováním auditního souboru a restartem s novou
cestou. Každý nový soubor tvoří samostatný řetězec. I odmítnuté validní tool calls
se auditují; dlouhodobý spam tak může vyčerpat kapacitu auditu. Tato etapa je
určená pro důvěryhodný lokální MCP host, bez veřejného síťového endpointu.

## Znalostní služba

Podrobný formát, schvalování, import a hash pin popisuje
[docs/knowledge.md](docs/knowledge.md). Služba přijímá pouze veřejný korpus a
kategorické dotazy; nepoužívá externí LLM, embedding API ani síťový scraper.
Odmítá nepokryté období/téma, zastaralý korpus, budoucí rozhodné datum, porušené
hashování a neplatná časová znění.

Pro samostatný proces spusťte `node dist/index.js --law-only` s proměnnými
`CZLAW_*` a vlastním `MCP_AUDIT_PATH`; tento režim odmítá konfiguraci s Flexi
credentials. Fyzickou síťovou izolaci zajišťuje provozní prostředí. Výchozí
server může používat stejnou knihovnu s veřejným korpusem lokálně; nejedná se
zatím o samostatnou HTTP službu ani plný sémantický právní vyhledávač.

## Stav ověření a další vývoj

`npm run check` provede strict TypeScript kontrolu, bezpečnostní/unit testy,
integraci s oficiálním MCP klientem a build. Testy spouštějí skutečné stdio
procesy pro obě protokolové generace. Flexi chování je ověřené na syntetických
fixtures i malými čtecími dotazy na živé firmě; viz [ověření](docs/verification.md).

První živé ověření může proběhnout i proti ostré firmě pod omezeným API účtem:
`server_info`, schéma faktur a jedna stránka s `fields:["id","kod"]`, `pageSize:1`.
Musí potvrdit skutečný tvar `properties.json` a reprezentaci částek/dat. Až
potom má smysl rozšiřovat datový kontrakt a účetní kontroly.

Po vyplnění `.env` a buildu spusťte `npm run smoke:flexi`. Skript přes skutečný
MCP klient zavolá tyto tři kontroly, na první povolené evidenci. Do konzole
nevypisuje vrácená účetní data ani credentials. Spotřebuje nejvýše dva upstream
GET requesty (schema a stránka), nic nezapisuje do Flexi. Schéma částek/dat je
potřeba ověřit následně samostatným cíleným testem; tento smoke čte pouze ID/kód.

Zbývá naplnění a odborné schválení právního korpusu, automatický update ingest,
účetní kontrolní pravidla, remote HTTP/OAuth, per-tenant deployment, denní quota
a provozní monitoring. Opravy existujících přijatých faktur jsou dostupné přes podepsané intenty.
Vytváření dokladů, mazání a další write workflows zůstávají další etapou.

Oficiální API podklad: [docs/research/abra-flexi-api.md](docs/research/abra-flexi-api.md).
Architektura a fáze: [docs/architecture.md](docs/architecture.md).
