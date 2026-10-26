# Lokální legislativní znalostní služba

Služba vyhledává pouze ve výslovně nastaveném, lidsky revidovaném vydání
veřejného legislativního korpusu. Nevolá síť, model ani externí vyhledávač;
nepřijímá faktury, účetní záznamy, identifikaci firmy ani volný dotaz. Součástí
repozitáře je pouze [registr oficiálních zdrojů](../src/law/registry.ts), žádné
normativní znění. Výchozí instalace proto poctivě vrací `not_ready` a odkazy
na primární zdroje. Samotný registr nepředstavuje ověřené platné znění.

## Rozhraní

```ts
import { LawService } from './src/law/index.ts';

const manifestPin = process.env.LAW_MANIFEST_SHA256;
const law = await LawService.create({
  corpusPath: '/srv/reviewed-law/releases/2026-10-26',
  ...(manifestPin ? { expectedManifestSha256: manifestPin } : {}),
  maxAgeDays: 30,
});
const status = law.status();
const result = law.search({
  asOf: '2026-10-26',
  regime: 'accounting',
  topics: ['records', 'retention'],
  limit: 20,
});
const provision = law.getProvision({ id: 'stable-provision-id', asOf: '2026-10-26' });
```

`corpusPath` může ukazovat přímo na soubor manifestu nebo na adresář obsahující
`manifest.json`. Bez cesty se nic automaticky nehledá. Chybný nebo nečitelný
nastavený korpus způsobí `LawValidationError` s kódem `LAW_VALIDATION_ERROR`;
služba nesmí vadný import tiše vydávat za provozuschopný.

Povinné datum `asOf` je skutečné občanské datum ve formátu `YYYY-MM-DD`,
například `2024-02-29`; hodnoty `today`, časová razítka ani `2026-02-29`
neprojdou. Režimy jsou `accounting` (účetnictví, zejména malá s.r.o.) a
`tax_evidence` (daňová evidence OSVČ). Témata tvoří pevný seznam:

- `records` – vedení záznamů;
- `invoicing` – doklady;
- `vat` – DPH;
- `income_tax` – daň z příjmů;
- `assets` – majetek;
- `inventory` – zásoby a inventarizace;
- `year_end` – uzavření období;
- `retention` – uchovávání záznamů.

Budoucí `asOf` vůči dnešnímu občanskému datu v časovém pásmu
`Europe/Prague` vrací v obou metodách `search` i `getProvision` stav
`not_ready`, důvod `future_as_of_not_supported` a žádné fragmenty.
To platí i pro otevřený interval nebo již načtenou budoucí verzi dokumentu.
MVP nevydává právní závěry pro budoucnost.

`search` nepřijímá žádné další parametry. Limit je celé číslo 1–50, výchozí
20. Výsledek uvádí `totalMatches` a `truncated`, aby omezená odpověď
nepředstírala úplnost. `getProvision` vybírá stabilní identifikátor fragmentu,
nikoli volný text ani firmu.

## Kontrakt revidovaného vydání

Adresář musí být spravován důvěryhodným administrátorem mimo dosah MCP klienta:

```text
2026-10-26/
  manifest.json
  snapshots/
    accounting-act-2026.txt
    income-tax-act-2026.txt
```

Přesné exportované typy jsou v [implementaci](../src/law/index.ts).
Manifest má tato povinná pole; neznámá pole jsou odmítnuta:

| Pole | Význam |
| --- | --- |
| `schemaVersion` | Přesně `1`. |
| `releaseId` | Jedinečný neměnný identifikátor vydání. |
| `classification` | Přesně `public_legislation`. |
| `publishedAt` | Čas zveřejnění tohoto lokálního vydání. |
| `approval` | `{status: "approved", reviewedBy, reviewedAt}`. |
| `coverage` | Pole výslovných prohlášení o úplném revidovaném pokrytí. |
| `documents` | Pole dokumentů s úplnými textovými snapshoty a fragmenty. |

Každý řádek `coverage` má `regime`, `topic`, `status: "complete"`,
`effectiveFrom` a `effectiveTo`. Pokrytí je prohlášení revizora o úplnosti
konkrétního tématu pro konkrétní režim v daném období, nikoli automatický
závěr z existence jediného dokumentu. Řádky stejné dvojice se nesmějí
překrývat. Jejich intervaly musí být alespoň strukturálně pokryty fragmenty
se stejným režimem a tématem. Skutečnou právní úplnost hash ani program
ověřit nedokáže; je odpovědností kvalifikované lidské revize.

Každý dokument obsahuje:

```ts
{
  id: string;             // jedinečné v rámci vydání
  title: string;
  sourceKind: 'law' | 'decree' | 'accounting_standard' | 'guidance';
  officialUrl: string;
  retrievedAt: string;
  verifiedAt: string;
  snapshot: { path: string; sha256: string };
  fragments: Array<{
    id: string;          // stabilní přes sousedící časové verze
    provision: string;   // přesná citace, např. paragraf/odstavec nebo číslo ČÚS
    regimes: Array<'accounting' | 'tax_evidence'>;
    topics: LawTopic[];
    effectiveFrom: string;
    effectiveTo: string | null;
    text: string;        // doslovný souvislý úryvek z úplného snapshotu
    sha256: string;
  }>;
}
```

Identifikátory vydání, dokumentu a fragmentu mají 1–128 znaků a odpovídají
`[A-Za-z0-9][A-Za-z0-9._:-]*`. Všechny časy jsou kanonické UTC timestampy
`YYYY-MM-DDTHH:mm:ss.sssZ`; musí platit
`retrievedAt <= verifiedAt <= reviewedAt <= publishedAt <= čas importu`.
Schválení vyžaduje neprázdné `reviewedBy`. Toto pole je auditní metadata,
nikoli kryptografický podpis identity revizora.

`officialUrl` musí používat HTTPS bez credentials a nestandardního portu
na přesném hostiteli `e-sbirka.gov.cz`, `mfcr.cz`, `www.mfcr.cz` nebo
`financnisprava.gov.cz`. Subdomény ani podobné domény neprojdou. Pro citace
používejte odkaz na konkrétní revidovanou verzi/ustanovení, pokud jej zdroj
umožňuje; registry a obecné rozcestníky samy nemohou nahradit textový snapshot.
`guidance` zůstává označená jako metodická informace a není převáděna na zákon.
Odkaz registru ČÚS na `www.mfcr.cz` nyní přesměrovává na `mf.gov.cz`.
Služba přesměrování nenásleduje. Kanonický host `mf.gov.cz` není v tomto
pevném seznamu; jeho případné přidání vyžaduje samostatnou revizi konfigurace
zdrojů a změnu implementace, nikdy automatickou důvěru v cíl přesměrování.

Snapshot je úplný revidovaný text dokumentu uložený v platném UTF-8.
`snapshot.sha256` je SHA-256 přes přesné bajty souboru, `fragment.sha256`
přes UTF-8 bajty `text` bez normalizace. Případnou extrakci PDF do textu
musí revizor porovnat s originálem. Uložte také původní stažený originál
do interního revizního archivu; služba jej nezpracovává. Každý fragment
musí být doslovně obsažen v odpovídajícím snapshotu. Cesta snapshotu musí
být relativní k manifestu a po rozlišení symlinků zůstat uvnitř tohoto adresáře.

Všechny intervaly jsou **od včetně, do výlučně**:
`effectiveFrom <= asOf < effectiveTo`. `null` znamená výslovně revidovaný
otevřený konec, nikdy ne automatický odhad neomezené platnosti. Dvě časové
verze stejného ID fragmentu se nesmějí překrývat; mohou přímo navazovat.
Pokud je známá budoucí změna, uzavřete interval stávající verze. Datum
účinnosti textu není totožné s datem jeho stažení či revize.

Ochranné limity: manifest 4 MiB, dokument 8 MiB, snapshoty celkem 64 MiB,
nejvýše 200 dokumentů, 5 000 fragmentů a 100 000 znaků na fragment.

## Kontrolovaný administrátorský import

1. Vyberte primární oficiální zdroje a přesné časové verze. Ověřte novely,
   přechodná ustanovení a dopad na oba podporované režimy. Nekopírujte do
   korpusu firemní data, faktury ani generovaný právní výklad.
2. V novém pracovním adresáři uložte úplné UTF-8 snapshoty, metadata a
   doslovné fragmenty; spočítejte jejich SHA-256. Zapište skutečné časy
   stažení a ověření. Nevyplňujte aktuální datum pouze kvůli prodloužení stáří.
3. Kvalifikovaný revizor porovná text, citace a účinnost s primárními zdroji.
   Do `coverage` přidá pouze dvojice a období, jejichž úplnost skutečně
   ověřil. Následně vyplní `reviewedBy`, `reviewedAt` a schválení.
4. Přidělte nové `releaseId`, zapište `publishedAt` a validujte přes
   `LawService.create({corpusPath: pracovníAdresář})`. Zkontrolujte `status()`
   a pozitivní i negativní dotazy na hranicích účinnosti. Neúplné vydání
   může být validní, ale jeho celkový stav musí zůstat `not_ready`.
5. Uzavřené vydání přesuňte do nového adresáře chráněného proti zápisu,
   spočítejte SHA-256 přes přesné bajty konečného `manifest.json` a tento
   digest nastavte odděleně jako `expectedManifestSha256`. Změna whitespace
   manifestu vyžaduje nový digest. Samotné hashe uvnitř měnitelného adresáře
   nezajišťují autenticitu; chráněná konfigurace a schvalovací proces tvoří
   hranici důvěry.
6. Administrátor explicitně nastaví novou cestu a digest a restartuje službu.
   Teprve ověřené dotazy na tomto procesu potvrzují zpřístupnění vydání.
   Předchozí vydání uchovejte pro audit a návrat. Automatické publikování,
   scraper ani stahování na pozadí nejsou implementovány.

Služba načte texty jednou do paměti a vrací kopie metadat a fragmentů.
Změna souborů na disku nezmění již načtené vydání. Jedno `releaseId` nikdy
znovu nepoužívejte pro odlišné bajty; v odpovědích je vždy i digest manifestu.

## Připravenost a stáří

`status()` označí korpus `ready` pouze tehdy, když má k dnešnímu datu
v časovém pásmu `Europe/Prague`
úplné revidované pokrytí všech dvojic podporovaných režimů a témat a žádný
dokument není zastaralý. To je provozní stav této omezené tematické služby,
nikoli prohlášení o kompletnosti českého práva.

`search()` posuzuje pokrytí pro požadované `asOf`, režim a všechna požadovaná
témata. Může tedy vrátit `ready` pro ověřenou část korpusu, přestože celkový
`status()` zůstává `not_ready`. `getProvision()` vyžaduje pokrytí všech režimů
a témat vybraného fragmentu. Při chybějícím pokrytí služba nevrátí žádný
normativní fragment ani částečný výsledek vydávaný za úplný.

Čerstvost se vyhodnocuje při každém volání vůči skutečnému času, nikoli vůči
`asOf`. Výchozí maximum je 30 dnů, administrátor smí nastavit hodnotu
větší než 0 a nejvýše 365. Jak stažení, tak ověření každého dokumentu musí
být nejvýše takto staré; přesná hraniční hodnota ještě vyhovuje. Zastaralý
dokument konzervativně zablokuje všechny normativní výsledky vydání, včetně
historických dotazů. Odpověď obsahuje důvod, `staleDocumentIds`, nejstarší
čas stažení a ověření i čas kontroly. Služba sama nikdy neobnovuje data.

Úspěšný výsledek vrací doslovný text, `provision`, typ zdroje, oficiální URL,
interval účinnosti, časy stažení a ověření, SHA-256 fragmentu a snapshotu,
identifikátor vydání a SHA-256 manifestu. Nevytváří závěry pro konkrétní
účetní případ. Neznámý identifikátor nebo datum mimo ověřené pokrytí vrací
`not_ready` s vysvětlením a oficiálním registrem.

## Ověření implementace

`node --test test/law.test.ts` vytváří čistě syntetické texty v dočasných
adresářích a ověřuje časové hranice, stáří, kontrolu hashů, schvalování,
podvržené domény, průnik symlinkem a chybějící pokrytí. Tyto testovací texty
nemají právní význam a nejsou distribuovány jako korpus.

Primární rozcestníky použité pro metadata registru:
[zákon o účetnictví](https://e-sbirka.gov.cz/sb/1991/563),
[vyhláška č. 500/2002 Sb.](https://e-sbirka.gov.cz/sb/2002/500),
[ČÚS – MF](https://www.mfcr.cz/cs/dane-a-ucetnictvi/ucetnictvi-a-ucetnictvi-statu/ucetnictvi-podnikatelu-a-neziskoveho-sek/ceske-ucetni-standardy-pro-podnikatele-a/2018),
[podnikatel OSVČ – Finanční správa](https://financnisprava.gov.cz/cs/dane/dane/dan-z-prijmu/fyzicke-osoby/podnikatel-osvc).
Tyto odkazy slouží k ruční revizi, nikoli jako tvrzení o platnosti jejich obsahu.
