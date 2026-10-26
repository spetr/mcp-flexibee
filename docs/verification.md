# Ověření první implementace

Ověřeno lokálně 2026-10-26 na macOS/ARM64, Node.js 26.12.1 a npm 11.20.0.

## Provedené kontroly

- Čistá reinstalace `npm ci --offline --ignore-scripts` z lokální cache prošla.
  Lockfile používá původní npm registry URL a integrity SHA-512 archivů.
- Strict TypeScript kontrola `npm run typecheck` prošla.
- Build `npm run build` prošel.
- Automatická sada: **46 testů prošlo**.
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

- Živé Flexi nebylo připojeno. Je nutné potvrdit skutečný `properties.json`
  envelope a reprezentaci dat/částek v konkrétní instanci. Smoke script zatím
  nebyl proti ostrému prostředí spuštěn.
- Právní korpus není naplněn ani odborně schválen. Automatické legislativní
  odpovědi a účetní kontrolní pravidla zatím nejsou dostupná.
- Online audit závislostí neproběhl kvůli omezené síti. Existující lokální
  dependencies nejsou tímto označeny za bezchybnou/produkčně auditovanou sadu.
- SDK 2.3.1 bylo dostupné v lokální cache; novější 2.4.0 je třeba otestovat po
  zpřístupnění jeho archivu. [Oficiální SDK releases](https://github.com/modelcontextprotocol/typescript-sdk/releases).
- Platné nadlimitní tool calls se stále auditují, takže lokální spam může
  vyčerpat auditní kapacitu a zastavit instanci. Rejected-call agregace a
  pokročilé provozní limity patří do další fáze.
- Remote HTTP/OAuth, oddělený produkční deployment a write workflows nejsou
  implementované.
- Vytvoření `.git` zablokovalo lokální oprávnění sandboxu. Projekt proto nebyl
  commitnut, pushnut ani publikován.
