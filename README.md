# MCP pro ABRA Flexi

TypeScript MCP server pro čtení účetních dat z jedné firmy ABRA Flexi a načítání
citovaných pasáží z ověřeného korpusu českých účetních a daňových předpisů.

První implementace je **read-only, lokální stdio**. Obsahuje skutečný MCP server,
Flexi klienta, runtime validaci schématu, podepsané stránkování, audit a legislativní
retrieval. Právní korpus zatím není naplněný: právní nástroje vracejí `not_ready`
a odkazy na oficiální zdroje. Žádné vzorové texty se nevydávají za platné právo.

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
        "--env-file=/Users/glux/devel/mcp-flexibee/.env",
        "/Users/glux/devel/mcp-flexibee/dist/index.js"
      ]
    }
  }
}
```

Použijte skutečnou absolutní cestu k Node 24+. `MCP_AUDIT_PATH` nastavte absolutně
a pro každou instanci zvlášť. Konfigurace MCP hosta se tímto projektem automaticky
nemění.

## Nástroje

| Nástroj | Účel |
|---|---|
| `server_info` | Připojená firma, povolené evidence, limity a připravenost korpusu |
| `flexi_schema_get` | Pole povolená lokální politikou i schématem firmy |
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

Povolené evidence: vydané/přijaté faktury a volitelně adresář/ceník. Výchozí
konfigurace povoluje jen faktury. Přesný field allowlist je v `src/flexi/policy.ts`.
API odpověď se znovu ořeže na požadovaná pole. Osobní a firemní údaje v povolených
polích zůstávají citlivými daty; tento server je neoznačuje za anonymizovaná.

Limity: nejvýše 100 záznamů na stránku, offset 10 000, 1 MiB upstream odpovědi
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
fixtures; připojení ke konkrétní živé firmě zatím ověřené není.

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
a provozní monitoring. Zápisy s dry-run, schválením a persistentní idempotencí
budou samostatná další etapa.

Oficiální API podklad: [docs/research/abra-flexi-api.md](docs/research/abra-flexi-api.md).
Architektura a fáze: [docs/architecture.md](docs/architecture.md).
