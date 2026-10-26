# Architektura první implementace

## Rozsah a hranice

MVP je lokální read-only MCP proces svázaný s jedinou firmou. Oficiální SDK v2
řeší protokol a stdio. Zod validuje přísná vstupní schémata, Flexi core samostatně
ověřuje doménovou politiku a upstream data. Transport tedy není bezpečnostním
validátorem domény.

```text
MCP host
  └─ official stdio SDK -> src/server.ts
       ├─ strict input / concurrency / quota / audit
       ├─ signed cursor -> src/cursor.ts
       ├─ read-only adapter -> src/flexi/client.ts -> configured HTTPS Flexi
       └─ dated citations -> src/law/index.ts -> pinned reviewed public release
```

`src/config.ts` čte environment pouze při startu. `src/audit.ts` zaznamenává
metadata, před upstream čtením vyžaduje úspěšný audit a při restartu ověřuje
existující řetězec. Lockfile udržuje jediného writera; jeho obnovu po pádu provádí
správce při vypnuté službě.

Legislativní core nemá síťovou komunikaci ani přístup ke credentials. Lze jej
spustit samostatně přes `--law-only`, které odmítá Flexi konfiguraci. V této
etapě jsou obě domény v jednom repozitáři a mohou být ve stejném lokálním
procesu; požadavek na fyzickou izolaci produkčních služeb bude splněn až
odděleným deploymentem s vlastní síťovou identitou a úložištěm.

## Rozhodnutí

- TypeScript strict, ESM, Node.js 24+; Node built-in HTTP/crypto/fs.
- Oficiální MCP SDK 2.3.1 a Zod 4.6.5, přesné verze a npm lockfile. Lokální
  instalace použila existující ověřované npm cache archivy, lifecycle scripts
  byly vypnuté. Cache není součástí projektu ani distribučního artefaktu.
- Modulární adresáře místo mnoha workspace balíků. Doménové core je nezávislé
  na MCP SDK a lze je později oddělit do samostatných balíků.
- Žádná databáze pro read-only MVP. Právní release je neměnný snapshot,
  audit append-only JSONL, cursory process-local HMAC. PostgreSQL přibude pro
  identitu, multi-tenancy a persistentní write/idempotency ledger.
- První právní retrieval je výběr podle režimu, tématu a data; neposkytuje
  sémantickou odpověď ani právní kalkulace. Neověřená coverage znamená `not_ready`.
- SDK poskytuje legacy i moderní wire chování. Nepíšeme vlastní JSON-RPC ani
  vlastní MCP handshake.

## Provedené role

Uživatel výslovně požadoval model a hloubku uvažování pro jednotlivé role.
Po počátečních chybách dostupnosti proběhla architektonická a rešeršní fáze na
`gpt-5.6-sol`: architekt high, oponent xhigh, rešeršér medium. Implementace
proběhla na `gpt-6.1-sol`: Flexi kodér high, legislativní kodér high,
bezpečnostní reviewer xhigh. Hlavní agent integruje a ověřuje celý celek.

Bezpečnostní review vedlo mimo jiné k blokaci budoucího `asOf` a exkluzivnímu
auditnímu zámku. Oba nálezy mají regresní testy.

## Další fáze

1. Ověřit konkrétní Flexi instanci omezeným čtením skutečného properties a
   záznamových payloadů; rozšířit kontraktní fixtures podle výsledků.
2. Importovat vybrané zákony, vyhlášku, ČÚS a metodiky. Odborně schválit texty,
   časové intervaly a tematické pokrytí. Teprve pak publikovat hash-pinned release.
3. Přidat ověřené účetní kontroly pro účetnictví a daňovou evidenci. Každé
   pravidlo dostane zdroj, časovou použitelnost a odborný eval dataset.
4. Oddělený deploy legislativního procesu a Flexi connectoru. Remote MCP vyžaduje
   OAuth resource server, ověřenou audience, scopes a tenant isolation.
5. Zápisy až s odděleným human approval kanálem, dry-run, diffem, persistentní
   idempotencí, external ID a reconciliation stavu `unknown`.

Server nikdy nezíská oprávnění k zápisu pouze z instrukce modelu nebo chatového
souhlasu. Bezpečnostní hranicí je serverová policy a přístupová role ve Flexi.
