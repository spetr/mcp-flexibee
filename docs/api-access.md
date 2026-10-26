# Přístup MCP k ABRA Flexi

Stav živého ověření: 2026-10-26. Režim `FLEXI_ALLOWED_EVIDENCES=*`.

API účtu zveřejňuje 169 evidencí. MCP povoluje obecné čtení 156 z nich; 13 evidencí s credentials, certifikáty nebo spustitelnou konfigurací blokuje. Tento počet je výsledek discovery, nikoli tvrzení, že se četla data ze všech evidencí. Práva API uživatele a licence ve Flexi jsou další hranicí přístupu.

## Podporované operace

- Objevení evidencí, polí, datových typů, hodnot výčtů a cílů referencí.
- Stránkované seznamy a detaily záznamů s explicitním výběrem polí.
- Typované AND filtry: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`.
- Objevení a stránkované čtení kolekcí navázaných na konkrétní záznam.
- Reference vracejí kód, zobrazovaný název a interní ID; navázaný záznam lze načíst z cílové evidence.

Origin a databázové jméno určuje konfigurace; argument `target` vybírá z nakonfigurovaných firem. Čtecí nástroje používají GET na pevně sestavených datových/metadata cestách. Nelze volat akce, import, mazání, placení, inicializaci období ani přepočty pomocí libovolné URL. Volitelné opravy existujících přijatých faktur od verze 0.4 mají samostatný [podepisovaný postup](invoice-updates.md).

## Živě ověřený účetní postup

Přes skutečný stdio MCP klient a nakonfigurovaný API účet:

1. Vyhledání jedné přijaté faktury podle `nazFirmy contains Google`.
2. Detail s dodavatelem, IČO/DIČ, daty DPH, částkami po sazbách, členěním DPH a kontrolního hlášení, referencemi na účty a stavem zaúčtování.
3. Čtení její položky přes `polozkyDokladu` s vlastními účty základu a DPH.
4. Dvě skutečné položky účetního deníku propojené podmínkami `idDokl eq <id faktury>` a `modulK eq modulUcetni.FAP`.
5. Čtení číselníku členění DPH a negativní kontrola blokovaného úložiště konfigurace.

Hodnoty dokladů a hesla se do testovacího výstupu nevypisovaly. Žádný produkční záznam nebyl změněn. Test potvrzuje dostupnost dat, neposuzuje daňovou správnost faktury.

## Rozsah a limity

Nejde o implementaci všech speciálních operací REST API. Kromě řízených oprav existujících přijatých faktur nejsou vystavené další zápisové postupy, akce, binární obsah příloh, PDF/ISDOC exporty a speciální agregační endpointy. Pole neznámého/binary datového typu a credential pole se nevracejí. Pole array obsahují pouze omezená pole skalárních hodnot; vnořené objekty se čtou přes evidenci nebo objevenou relaci.

Nejvýše 100 záznamů na stránku, 200 vybraných polí, offset 10 000, deset AND filtrů, 1 MiB upstream odpovědi (konfigurovatelné do 4 MiB), 512 KiB MCP výsledku a 60 volání za minutu. Cursory jsou vázané na proces a celý dotaz; nejde o konzistentní databázový snapshot. Metadata se cachují pět minut. U sestav bez podporované číselné identity se používá seznam, nikoli detail podle ID.

## Více firem ve verzi 0.3

Aktivní instalace používá registr serverů a explicitní produkční cíl.
Výše uvedená tabulka je snapshot této firmy; neopravňuje přenášet její schéma
nebo účetní závěry na jinou firmu. Celkem je dostupných 13 čtecích nástrojů.
`flexi_server_list`, `flexi_company_list` a stránkovaný `flexi_target_list` slouží
k discovery. Datové dotazy mají `target`; při více nakonfigurovaných cílech je
povinný. Právní korpus je veřejný a sdílený. [Podrobnosti](multi-server-companies.md).

## Jak pokračovat v ChatGPT

Po restartu MCP a načtení nové konfigurace zavolejte `flexi_target_list` a poté `server_info` s konkrétním `target`; pro široký čtecí profil vrátí `fieldAccess: runtime_schema` a `allowedEvidences: ["*"]`. K dispozici je třináct čtecích nástrojů; zapnuté opravy faktur přidávají tři další. Starší běžící proces si ponechá původní konfiguraci až do restartu.

Pro kontrolu DPH nejprve načtěte schéma; pole `primUcet`/`protiUcet` na hlavičce jsou předpisem, ne náhradou skutečných položek v `ucetni-denik`. Právní korpus nadále vrací `not_ready`; jeho naplnění a odborné schválení je samostatná práce.

## Přehled evidencí

Sloupec Přístup označuje dostupnost podle discovery a politiky MCP. Každé datové čtení musí navíc projít právy serveru Flexi.

| Evidence | Název | Přístup |
|---|---|---|
| `kontakt` | Kontakty | čtení |
| `adresar` | Adresy firem | čtení |
| `udalost` | Události, aktivity | čtení |
| `adresar-bankovni-ucet` | Bankovní spojení | čtení |
| `skupina-firem` | Skupiny firem | čtení |
| `smlouva-zurnal` | Žurnál pro smlouvy | čtení |
| `faktura-prijata` | Přijaté faktury | čtení |
| `faktura-prijata-polozka` | Položky přijatých faktur | čtení |
| `typ-faktury-prijate` | Typy přijatých faktur | čtení |
| `rada-faktury-prijate` | Dokladové řady - přijaté faktury | čtení |
| `predpis-zauctovani` | Předpisy zaúčtování | čtení |
| `def-store` | Úložiště definic | blokovaná konfigurace/credentials |
| `rada` | dokladové řady | čtení |
| `rocni-rada` | Roční položky dokladové řady | čtení |
| `misto-urceni` | Místa určení | čtení |
| `text` | Předdefinované texty | čtení |
| `neuhrazene-po-splatnosti` | Neuhrazené po splatnosti | čtení |
| `neuhrazene-po-splatnosti-2` | Neuhrazené po splatnosti - uhrazené | čtení |
| `pokladni-pohyb` | Pokladna | čtení |
| `pokladni-pohyb-polozka` | Položky pokladních dokladů | čtení |
| `rada-pokladni-pohyb` | Dokladové řady - pokladní doklady | čtení |
| `typ-pokladni-pohyb` | Typy pokladních dokladů | čtení |
| `banka` | Banka | čtení |
| `typ-banka` | Typy bankovních dokladů | čtení |
| `rada-banka` | Dokladové řady - bankovní doklady | čtení |
| `banka-polozka` | Položky banky a vzájemných zápočtů | čtení |
| `format-elektronickeho-bankovnictvi` | Bankovní formáty | čtení |
| `format-elektronickeho-prikazu` | Bankovní formáty | čtení |
| `pohledavka` | Ostatní pohledávky | čtení |
| `pohledavka-polozka` | Položky ostatních pohledávek | čtení |
| `typ-pohledavky` | Typy ostatních pohledávek | čtení |
| `rada-pohledavky` | Dokladové řady - pohledávky | čtení |
| `uplatneni-dane-zavazku` | Uplatnění daně - závazky | čtení |
| `uplatneni-dane-zavazku-polozka` | Položky uplatnění daně - závazky | čtení |
| `typ-uplatneni-dane-zavazku` | Typy uplatnění daně - závazky | čtení |
| `rada-uplatneni-dane-zavazku` | Dokladové řady - uplatnění daně - závazky | čtení |
| `bankovni-ucet` | Seznam bankovních účtů | čtení |
| `pokladna` | Seznam pokladen | čtení |
| `bankovni-ucet-pokladna` | Bankovní účty a pokladny | čtení |
| `prikaz-k-uhrade` | Příkaz k úhradě | čtení |
| `prikaz-k-uhrade-polozka` | Položka příkazu k úhradě | čtení |
| `prikaz-k-inkasu-polozka` | Položka inkasa | čtení |
| `doklad-k-uhrade` | Doklady k úhradě | čtení |
| `vzajemny-zapocet` | Vzájemné zápočty | čtení |
| `typ-vzajemnych-zapoctu` | Typy zápočtů | čtení |
| `bankovni-ucet-sklad-pokladna` | Banky/pokladny/sklady | čtení |
| `typ-interniho-dokladu` | Typy interních dokladů | čtení |
| `rada-interniho-dokladu` | Dokladové řady - interní doklady | čtení |
| `interni-doklad` | Interní doklady | čtení |
| `interni-doklad-polozka` | Položky interních dokladů | čtení |
| `doklad` | Přehled všech dokladů | čtení |
| `vazba` | Vazby dokladu | čtení |
| `vazebni-doklad` | Navázané doklady | čtení |
| `priloha` | Příloha | čtení |
| `typ-dokladu` | Typy dokladů | čtení |
| `zaloha-k-odpoctu` | Zálohy k odpočtu | čtení |
| `castky-k-odpoctu` | Částky k odpočtu | čtení |
| `doporuceni` | Doporučení | čtení |
| `faktura-vydana` | Vydané faktury | čtení |
| `faktura-vydana-polozka` | Položky vydaných faktur a prodejek | čtení |
| `typ-faktury-vydane` | Typy vydaných faktur | čtení |
| `rada-faktury-vydane` | Dokladové řady - vydané faktury | čtení |
| `pristupove-pravo` | Přístupová práva | čtení |
| `pravo-viditelnosti` | Práva viditelnosti dat | čtení |
| `kurz` | Kurzy | čtení |
| `ucet` | Účtový rozvrh | čtení |
| `mena` | Měny | čtení |
| `stat` | Státy | čtení |
| `stat-dph` | Státy DPH | čtení |
| `stredisko` | Střediska | čtení |
| `sazba-dph` | Sazby DPH | čtení |
| `konst-symbol` | Konstantní symboly | čtení |
| `merna-jednotka` | Měrné jednotky  | čtení |
| `skupina-plneni` | Skupiny plnění | čtení |
| `region` | Kraje | čtení |
| `cleneni-dph` | Řádky přiznání DPH | čtení |
| `cleneni-kontrolni-hlaseni` | Řádky kontrolního hlášení DPH | čtení |
| `ucetni-osnova` | Standardní účetní osnova | čtení |
| `ucetni-obdobi` | Účetní období | čtení |
| `typ-organizace` | Typ organizace | čtení |
| `kurz-pro-preceneni` | Kurzy pro přecenění | čtení |
| `penezni-ustav` | Peněžní ústavy | čtení |
| `psc` | Poštovní směrovací čísla | čtení |
| `stitek` | Štítky | čtení |
| `skupina-stitku` | Skupiny štítků | čtení |
| `preneseni-dph` | Seznam zboží v režimu přenesení DPH | čtení |
| `forma-uhrady` | Formy úhrady | čtení |
| `stav-obchodniho-dokladu` | Stav obchodního dokladu | čtení |
| `forma-uhrady-zauctovani` | Zaúčtování formy úhrady | čtení |
| `certifikacni-autorita` | Certifikační autority | blokovaná konfigurace/credentials |
| `certifikat-finbricks` | Klíče Finbricks | blokovaná konfigurace/credentials |
| `certifikat` | Certifikáty | blokovaná konfigurace/credentials |
| `forma-dopravy` | Formy dopravy | čtení |
| `typ-uzivatelske-vazby` | Typy uživatelských vazeb | čtení |
| `uzivatelska-vazba` | Uživatelské vazby | čtení |
| `skladova-karta` | Skladové karty | čtení |
| `cenik` | Ceník | čtení |
| `skupina-zbozi` | Skupiny zboží a materiálu | čtení |
| `skladovy-pohyb` | Příjemky/výdejky | čtení |
| `skladovy-pohyb-polozka` | Položky příjemky/výdejky | čtení |
| `rada-skladovy-pohyb` | Dokladové řady - sklad | čtení |
| `typ-skladovy-pohyb` | Typy skladových dokladů | čtení |
| `sklad` | Seznam skladů | čtení |
| `strom` | Uzel stromu | čtení |
| `inventura` | Inventury | čtení |
| `inventura-polozka` | Položky inventur | čtení |
| `stav-skladu-k-datu` | Stav skladu k datu | čtení |
| `sarze-expirace` | Šarže a expirace | čtení |
| `majetek` | Majetek | čtení |
| `leasing` | Leasing | čtení |
| `splatkovy-kalendar` | Splátkový kalendář | čtení |
| `danovy-naklad` | Daňové náklady | čtení |
| `typ-majetku` | Typy majetků | čtení |
| `typ-leasingu` | Typy leasingů | čtení |
| `umisteni` | Umístění | čtení |
| `odpisova-skupina` | Odpisové skupiny | čtení |
| `majetek-udalost` | Události | čtení |
| `zapujcka` | Zápůjčky | čtení |
| `danovy-odpis` | Daňové odpisy | čtení |
| `ucetni-odpis` | Účetní odpisy | čtení |
| `zavazek` | Ostatní závazky | čtení |
| `zavazek-polozka` | Položky ostatních závazků | čtení |
| `typ-zavazku` | Typy ostatních závazků | čtení |
| `rada-zavazku` | Dokladové řady - závazky | čtení |
| `filtr` | Uživatelské filtry | čtení |
| `parametr` | Pokročilá parametrizace pomocí parametrů | čtení |
| `custom-button` | Uživatelské tlačítko | blokovaná konfigurace/credentials |
| `setting-store` | Úložiště nastavení | blokovaná konfigurace/credentials |
| `global-store` | Úložiště globálního nastavení | blokovaná konfigurace/credentials |
| `dashboard-panel` | Správa přehledů | čtení |
| `dashboard-sharing` | Sdílení přehledů | čtení |
| `insight` | Insight | čtení |
| `automatizace-typ` | Typy automatizací | blokovaná konfigurace/credentials |
| `automatizace` | Automatizace | blokovaná konfigurace/credentials |
| `doplnek` | Doplněk | blokovaná konfigurace/credentials |
| `objekt-doplnku` | Objekt doplňku | blokovaná konfigurace/credentials |
| `integrace` | Integrace | blokovaná konfigurace/credentials |
| `autotisk` | Automatický tisk | čtení |
| `xslt` | Uživatelské transformace | blokovaná konfigurace/credentials |
| `obrat` | Obraty | čtení |
| `stav-uctu` | Stavy účtů | čtení |
| `hlavni-kniha` | Hlavní kniha | čtení |
| `obratova-predvaha` | Obratová předvaha | čtení |
| `podklady-dph` | Podklady DPH | čtení |
| `souhrnne-hlaseni-dph` | Souhrnné hlášení k DPH | čtení |
| `kontrolni-hlaseni-dph` | Kontrolní hlášení DPH | čtení |
| `pohyb-na-uctech` | Pohyby na účtech | čtení |
| `ucetni-denik` | Účetní deník | čtení |
| `umisteni-uctu` | Upřesnění umístění účtu | čtení |
| `pricteni-rozdilu` | Řádky pro přičtení rozdílu | čtení |
| `rozpad-radku` | Rozpad řádků sestavy na účty | čtení |
| `uziv-predpis` | Předpis sestavy | čtení |
| `saldo` | Saldo | čtení |
| `rozvaha-po-uctech` | Soupis aktiv a pasiv | čtení |
| `vysledovka-po-uctech` | Soupis nákladů a výnosů | čtení |
| `cenikovy-pohyb-nakup` | Nákupní, prodejní a skladové pohyby | čtení |
| `cenikovy-pohyb-prodej` | Nákupní, prodejní a skladové pohyby | čtení |
| `vykaz-hospodareni` | Výkaz hospodaření za měsíc | čtení |
| `po-splatnosti` | Neuhrazené pohledávky/závazky po splatnosti | čtení |
| `saldo-k-datu` | Stav úhrad k datu | čtení |
| `sestava` | Seznam sestav | čtení |
| `radek-sestavy` | Řádek sestavy | čtení |
| `sumace-sestavy` | Sumace v sestavách | čtení |
| `standardni-predpis` | Standardní předpis sestavy | čtení |
| `subjekt` | Subjekt | čtení |
| `radek-priznani-dph` | Řádky uloženého přiznání DPH | čtení |
| `ulozene-priznani-dph` | Uložené přiznání DPH | čtení |
| `ulozene-priznani-kon-vyk-dph` | Uložené přiznání Kontrolního hlášení DPH | čtení |
| `zurnal` | Žurnál | čtení |

Podklad k datovým cestám a relacím: [ABRA Flexi – Building URLs](https://podpora.flexibee.eu/en/articles/4713911-building-urls). K výběru polí: [Levels of Detail](https://podpora.flexibee.eu/en/articles/4722190-levels-of-detail).
