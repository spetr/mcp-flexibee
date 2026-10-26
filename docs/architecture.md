# Architektura implementace

## Rozsah a hranice

Server je lokální MCP proces s výchozím režimem pouze pro čtení. Verze 0.3 podporuje registr více serverů a firem; verze 0.4 přidává volitelné podepisované opravy existujících přijatých faktur. Původní jednofiremní konfigurace zůstává kompatibilní. Oficiální SDK v2
řeší protokol a stdio. Zod validuje přísná vstupní schémata, Flexi core samostatně
ověřuje doménovou politiku a upstream data. Transport tedy není bezpečnostním
validátorem domény.

```text
MCP host
  └─ official stdio SDK -> src/server.ts
       ├─ strict input / concurrency / quota / audit
       ├─ signed cursor -> src/cursor.ts
       ├─ read-only adapter -> src/flexi/client.ts -> configured HTTPS Flexi
       ├─ optional invoice updates -> signed intent -> fixed invoice PUT
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
  audit append-only JSONL, cursory process-local HMAC. Verze 0.4 používá lokální
  persistentní úložiště podepsaných návrhů a výsledků; případný PostgreSQL je
  další etapou pro vzdálený provoz a více uživatelů.
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

## Rozšíření čtecí vrstvy 0.2

`FLEXI_ALLOWED_EVIDENCES=*` zapíná discovery evidencí a polí podle metadat a role API uživatele. `src/flexi/metadata.ts` validuje názvy, typy a vazby; credential a spustitelná konfigurace jsou blokované. Jednotlivé operace stále konstruují pouze pevné GET cesty uvnitř jedné firmy. Kolekce navázaných záznamů mají samostatné stránkování a cursor svázaný s rodičem. Původní omezený režim zůstává pro explicitní seznamy evidencí. Živé čtecí ověření a další hranice popisují `verification.md` a `api-access.md`.

## Více serverů a firem 0.3

`src/connections.ts` drží neměnné cíle server/firma a samostatné firemní klienty.
`src/flexi/transport.ts` sdílí HTTP limity podle originu, včetně aliasů a credential
profilů. Registry rozlišuje lokální target od Flexi `dbNazev` a ověřuje přístup i
připravenost firmy přes stránkované `/c.json`. Firemní metadata, audit a cursor
binding obsahují cíl; neexistuje globální aktivní firma. Legislativa zůstává
veřejná a sdílená. [Podrobnosti](multi-server-companies.md).

## Další fáze

1. Ověřit konkrétní Flexi instanci omezeným čtením skutečného properties a
   záznamových payloadů; rozšířit kontraktní fixtures podle výsledků.
2. Importovat vybrané zákony, vyhlášku, ČÚS a metodiky. Odborně schválit texty,
   časové intervaly a tematické pokrytí. Teprve pak publikovat hash-pinned release.
3. Přidat ověřené účetní kontroly pro účetnictví a daňovou evidenci. Každé
   pravidlo dostane zdroj, časovou použitelnost a odborný eval dataset.
4. Oddělený deploy legislativního procesu a Flexi connectoru. Remote MCP vyžaduje
   OAuth resource server, ověřenou audience, scopes a tenant isolation.
5. Rozšířit podepisovaný update-existing postup 0.4 o další domény až s vlastními
   kontrakty. Unknown zůstává blokovaný do operátorské reconciliation; nevytvářet
   automatické retry ani obecný write proxy.

Server nikdy nezíská oprávnění k zápisu pouze z instrukce modelu nebo chatového
souhlasu. Bezpečnostní hranicí je serverová policy a přístupová role ve Flexi.

## Řízené opravy přijatých faktur 0.4

`src/writes.ts` připravuje a ověřuje přesné změny existující přijaté faktury,
`src/write-store.ts` drží immutable návrh/digest, oddělený podpis, persistentní
stav a zámky/fence dokumentu. `scripts/approve-write.ts` je operátorská CLI mimo
MCP. Nativní transport má jedinou úzkou update-existing metodu, zámek Flexi
`as-gui=true`/`lastUpdate` a create-fail/update-ok na dokladu i všech položkách.
Schválení zahrnuje vypočtený dry-run a jeho vedlejší změny; výsledek ověřuje i
finanční invarianty a zadané účetní řádky. Žádná nedoložená regenerate akce se
nevolá. [Podrobný postup](invoice-updates.md).
