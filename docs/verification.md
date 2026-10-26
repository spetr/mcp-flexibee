# Ověření implementace

Ověřeno lokálně 2026-10-26 na macOS/ARM64, Node.js 26.12.1 a npm 11.20.0.

## Řízené invoice updates 0.4

- Přibyly per-target allowlisty writable polí, opt-in konfigurace, veřejný schvalovací
  klíč a persistentní úložiště podepisovaných intentů. MCP nevystavuje approve tool.
- Nové SDK tool schemas a anotace odlišují preview/status/commit; audit po možném
  zápisu nesmí tvrdit, že se operace pouze zablokovala. Unknown/pending commit
  nevrací ověřený úspěch. Stav lze přečíst i bez dostupného API.
- 13 core write testů: přesný update-only/CAS payload, schválení a jeho tamper,
  expirace i po pomalém preflightu, stale/membership/role/schema konflikty,
  kontrola účetního deníku a finančních invariantů, digest actualdryrun, restart,
  souběh, chyby persistence po dispatch a fyzický dokumentový unknown fence.
- Další SDK a config testy pokrývají správná read/write metadata, nepřípustné
  replacement payloads/URL/approval flags a fail-closed audit.
- Živý test přijaté faktury: stale `lastUpdate` s `as-gui=true&dry-run=true` vrátil HTTP 409.
  Platná verze vrátila 200, success=true a stats updated=1, created/deleted/failed=0.
  Vypočtený obsah má EU službu `05-06, 43-44`, KH `A.2.` a stejné částky.
  Následné GET ověřilo identické zdrojové snapshoty; dry-run fakturu neuložil.
- Přes nový MCP vznikl nepodepsaný intent pro přesný doklad a jeho položku.
  Vypočtený diff obsahuje pouze dvě klasifikační změny v hlavičce i položce.
  Skutečné uložení vyžaduje operátorský podpis a není označené za provedené.
- Architekt a oponent zkontrolovali opravy P1/P2, průzkumník zdokumentoval primární
  API i DPH zdroje. [Kontrakt](research/invoice-write-contract.md), [provoz](invoice-updates.md).

## Více serverů a firem 0.3

- Architekt, oponent, legislativní průzkumník a kodér se podíleli na návrhu,
  implementaci a review. Závěry o identitě firmy a přístupech jsou v návrhovém dokumentu.
- Striktní konfigurace serverů/credential profilů/cílů, immutable registry,
  sdílené HTTP limity podle originu, explicitní target a firemní metadata/audit.
- Testy pro dva mock API servery × dvě firmy, shodná ID dokladů a odlišné profily,
  oddělené cache/schémata/politiky, stránkování a cross-target/server cursor replay.
- Real stdio vícefiremní konfigurace vyjedná oba podporované protokoly. Chybějící
  cíl se odmítne před síťovým čtením; právní nástroje zůstávají nezávislé.
- Opravené review nálezy: legacy budget bypass; nesprávně hlášené schopnosti
  omezeného cíle; neomezené discovery výpisy; cursor nad limitem; starý readiness
  snapshot po čerstvém refresh; souběh opožděné staré odpovědi a nového zákazu;
  chybějící firma v kompletním snapshotu. Opravy mají regresní testy.
- Živé ověření přes nakonfigurovaný ChatGPT launcher: 13 nástrojů, seznam serverů
  a firem, explicitní produkční cíl, readiness, schéma a nejvýše jeden doklad.
  Účetní hodnoty ani credentials nebyly vypsány; žádný záznam ve Flexi se neměnil.
- Instalace migrována na `.state/connections.json`, původní konfigurace a `.env`
  mají soukromou zálohu pod `.state/install-backups/`. Credentials se nezměnily.
- Testovaci se aktuálnímu API účtu zatím nevrací; její DB identifikátor nebyl
  odhadován ani přidán do aktivního allowlistu. Živé čtení druhé firmy a dalšího
  skutečného API serveru proto není označené za ověřené. Vícefiremní izolaci
  prokazují výše uvedené mock a stdio testy.

## Rozšíření čtecího API 0.2

- Režim `*` ověřen skutečným MCP klientem proti živé firmě; discovery 169 evidencí, z toho 156 povolených pro čtení politikou MCP.
- Faktura Google: dodavatel/DIČ, DPH a účetní reference, položka faktury a dvě související položky účetního deníku byly úspěšně načteny.
- Ověřené skutečné tvary metadat: `evidences.evidence`, `properties.property`, `relations.relation`; reference, booleany, výčty, rok/měsíc a seznamy ID.
- Produkční data nebyla měněna. Žádná mutující metoda ani akce není implementována.
- Automatické testy zahrnují nové discovery/role, credential denylist, metadata injection, přesné částky a cursor vazbu na rodičovský záznam.
- Podrobný rozsah a přehled evidencí: [api-access.md](api-access.md).

## Provedené kontroly

- Čistá reinstalace `npm ci --offline --ignore-scripts` z lokální cache prošla.
  Lockfile používá původní npm registry URL a integrity SHA-512 archivů.
- Strict TypeScript kontrola `npm run typecheck` prošla.
- Build `npm run build` prošel.
- Automatická sada: **92 testů prošlo**.
- Syntetické Flexi fixtures pokrývají povolené URL, runtime schema, typované
  filtry, výstupní projekci, přesné decimální řetězce, chybné MIME/JSON,
  redirecty, přenosové limity, timeout celého streamu a omezení souběhu.
- Legislativní testy pokrývají integritu manifestu/snapshotů/fragmentů,
  schvalovací metadata, časové intervaly, freshness, pokrytí, falešné zdrojové
  domény, traversal/symlinky a českou půlnoc při blokování budoucích dotazů.
- Auditní testy pokrývají sériové zápisy, restart, detekci poškození, oprávnění
  souboru, symlinky a výhradní zámek včetně fail-closed při existujícím zámku.
- Integrační testy používají oficiální MCP klient a skutečné stdio subprocessy.
  Ověřené jsou TS zdroj i kompilovaný `dist/index.js`, legacy handshake i
  protokol `2026-07-28`, tool discovery/calls, resources a prompt.
- Nezávislý bezpečnostní reviewer provedl další pokusy o záměnu firmy,
  mutující GET cestu, změnu cursor query, únik secrets a selhání auditu.

## Opravené nálezy review

1. Právní korpus s otevřeným intervalem mohl vracet `ready` pro budoucí datum.
   Oprava: future `asOf` je odmítnuto vzhledem k občanskému datu Europe/Prague.
2. Dva audity nad stejnou cestou mohly vytvořit větvený hash chain.
   Oprava: atomické získání výhradního lockfile a řízené odstranění při close.

## Zbývající hranice

- Discovery zpřístupňuje obecné čtení dostupných evidencí, nikoli všechny speciální endpointy REST API. Metadata všech evidencí nejsou totéž jako behaviorální ověření každé sestavy. Binární přílohy, PDF/ISDOC a agregace nejsou implementované.
- Právní korpus není naplněn ani odborně schválen. Automatické legislativní
  odpovědi a účetní kontrolní pravidla zatím nejsou dostupná.
- Online audit závislostí neproběhl kvůli omezené síti. Existující lokální
  dependencies nejsou tímto označeny za bezchybnou/produkčně auditovanou sadu.
- SDK 2.3.1 bylo dostupné v lokální cache; novější 2.4.0 je třeba otestovat po
  zpřístupnění jeho archivu. [Oficiální SDK releases](https://github.com/modelcontextprotocol/typescript-sdk/releases).
- Platné nadlimitní tool calls se stále auditují, takže lokální spam může
  vyčerpat auditní kapacitu a zastavit instanci. Rejected-call agregace a
  pokročilé provozní limity patří do další fáze.
- Remote HTTP/OAuth, oddělený produkční deployment, vytváření/mazání dokladů a
  další write workflows nejsou implementované. Opravy existujících přijatých faktur
  mají vlastní omezený podepisovaný postup od verze 0.4.
- Vytvoření `.git` zablokovalo lokální oprávnění sandboxu. Projekt proto nebyl
  commitnut, pushnut ani publikován.
