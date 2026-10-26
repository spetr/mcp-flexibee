# Úprava přijaté faktury: API kontrakt a podmínky DPH

Stav ověření: 2026-10-26. Dokument odděluje oficiální API kontrakt,
pozorování živého dry-run a podmíněný daňový závěr. Neobsahuje přístupové
údaje, bankovní údaje ani osobní údaje zákazníka. Při tomto průzkumu nebyla
provedena produkční mutace ani daňové podání.

## 1. Výhradně aktualizace konkrétního dokladu

Použít přesný server, firmu a číselné ID faktury; předem načíst její aktuální
stav a ověřit, že všechna upravovaná ID položek patří právě této faktuře.

```http
PUT /c/{company}/faktura-prijata/{invoiceId}.json?as-gui=true&dry-run=true&fail-on-warning=true
Content-Type: application/json
```

Změnu provádí standardní import existujícího ID, nikoli `@action: "update"`.
Taková akce nebyla v ověřené dokumentaci doložena. Zápis musí mít
`@create: "fail"` a `@update: "ok"` na faktuře i každé měněné existující
položce. Bez identifikátoru položky může import vytvořit další položku.
Nepoužívat `removeAll`, vytváření chybějících vazeb ani mazání položek.

Následuje ilustrační tvar se zástupnými ID, časem a referencemi; nejde
o payload určený k přímému spuštění:

```json
{
  "winstrom": {
    "@version": "1.0",
    "faktura-prijata": [{
      "id": "1234",
      "@create": "fail",
      "@update": "ok",
      "lastUpdate": "<přesná hodnota z předchozího GET>",
      "clenDph": "code:<nové členění>",
      "clenDph@previousValue": "code:<původní členění>",
      "polozkyDokladu": [{
        "id": "5678",
        "@create": "fail",
        "@update": "ok",
        "clenDph": "code:<nové členění>",
        "clenDph@previousValue": "code:<původní členění>"
      }]
    }]
  }
}
```

Oficiální příklady používají jak `polozkyFaktury`, tak novější
`polozkyDokladu`. Živý dry-run této instance přijal vstupní pole
`polozkyDokladu` a ve výstupu vrátil alias `polozkyFaktury`. Nelze
předpokládat libovolnou zaměnitelnost všech obalů ve všech verzích;
adaptér musí mít ověřený konkrétní tvar.

Zdroje: [HTTP operace](https://podpora.flexibee.eu/en/articles/4720093-supported-http-operations),
[režimy create/update](https://podpora.flexibee.eu/cs/articles/4725944-rezim-pro-zalozeni-zmenu),
[inkrementální aktualizace](https://podpora.flexibee.eu/cs/articles/4725908-inkrementalni-aktualizace),
[transakce a příklad polozkyFaktury](https://podpora.flexibee.eu/cs/articles/4726125-transakcni-zpracovani),
[polozkyDokladu a kopírování hlavičky](https://podpora.flexibee.eu/en/articles/8812898-copying-data-from-the-header-to-the-document-item).

## 2. Souběžné změny a reakce na změnu

Kombinace `as-gui=true` a přesné přečtené hodnoty `lastUpdate` v zapisovaném
dokladu zapíná doložené optimistické zamykání. Zastaralý čas vrací HTTP 409
a chybu `CONFLICT` pro `lastUpdate`. Konflikt vyžaduje nový GET a nové
posouzení rozdílu; nesmí vést k automatickému přepsání novým časem.
Podpora HTTP `If-Match` pro tento postup nebyla doložena.

`previousValue` slouží ke spuštění závislé obchodní logiky, nikoli jako
náhrada kontroly souběhu. Moderní dokumentace uvádí JSON zápis
`"kopClenKonVykDph@previousValue": "true"`; starší článek uvádí
`firma-previousValue`. V adaptéru používat ověřený moderní zápis s `@`.
Reakce se spouští při skutečné změně; opětovné nastavení stejného typu
dokladu nemusí změnit účty.

Položky mohou dědit členění a účty přes `kopClenDph`,
`kopClenKonVykDph`, `kopTypUcOp`, `kopZklMdUcet`, `kopZklDalUcet`,
`kopDphMdUcet`, `kopDphDalUcet`. Změna samotné hlavičky proto není důkazem
správných položek nebo účetního deníku. Nevypínat dědění bez konkrétního
důvodu a kontroly výsledku.

Zdroje: [optimistické zamykání od verze 2023.5](https://podpora.flexibee.eu/cs/articles/8450122-desktopova-aplikace-novinky-ve-verzi-2023-5),
[význam previousValue a starší JSON zápis](https://podpora.flexibee.eu/cs/articles/4726038-predchozi-hodnota-zpusob-reakce-na-zmenu),
[moderní @previousValue a dědění](https://podpora.flexibee.eu/en/articles/8812898-copying-data-from-the-header-to-the-document-item).

## 3. Dry-run, transakce a ověření odpovědi

`dry-run=true` provede validace a vrátí vypočtenou podobu dokladu v
`content`, ale neuloží jej. `fail-on-warning=true` má blokovat zápis i při
varování. Zachovat výchozí atomický import jedné faktury s položkami;
nevystavovat `atomic=false` klientovi. Dry-run a pozdější skutečný zápis
jsou samostatné požadavky, nikoli jedna společná transakce.

Obecná importní odpověď má `winstrom.success`, `winstrom.stats` a pole
`winstrom.results`. Oficiální JSON příklad vrací `success` a čítače jako
řetězce, například `"true"`, `"1"`, `"0"`. Adaptér musí hodnoty explicitně
normalizovat, nikoli testovat pravdivost řetězce `"false"`.
Dry-run vrací navíc vypočtený objekt. Živá instance vrátila přesně tuto
strukturu (hodnoty dokladu jsou zde vynechány):

```text
response.winstrom.results                         ARRAY
response.winstrom.results[0].content              OBJECT
response.winstrom.results[0].content["faktura-prijata"]
                                                 INVOICE_OBJECT
INVOICE_OBJECT.polozkyFaktury                     ARRAY of item OBJECTs
```

`content["faktura-prijata"]` tedy není pole. Normalizátor musí rozlišovat
pole výsledků importu od objektu faktury uvnitř `content`.

Za úspěch samotné HTTP 200 nestačí. Kontrolovat `success`, všechny chyby
a varování, čítače a cílové ID. Pro tento update očekávat nulové
`created`, `deleted`, `failed`, `skipped` a odpovídající `updated`.
Ani `updated=1` v dry-run neznamená uložení. Po skutečném zápisu je nutný
nový GET faktury, položek a relevantních řádků `ucetni-denik` pro konkrétní
zdrojový doklad a modul.

Zdroje: [dry-run](https://podpora.flexibee.eu/cs/articles/4720123-testovaci-ulozeni-dry-run),
[validace a fail-on-warning](https://podpora.flexibee.eu/cs/articles/4720108-validace-dat),
[transakční zpracování](https://podpora.flexibee.eu/cs/articles/4726125-transakcni-zpracovani),
[JSON návratové hodnoty](https://podpora.flexibee.eu/cs/articles/4719646-navratove-hodnoty),
[účetní výstupy](https://podpora.flexibee.eu/cs/articles/4971496-ucetni-vystupy-v-rest-api).

### Živé pozorování této implementace

Kořenový agent 2026-10-26 ověřil nad konkrétní přijatou fakturou pouze
dry-run: zastaralé `lastUpdate` skončilo HTTP 409; aktuální hodnota vedla
k HTTP 200, úspěšné odpovědi a statistice `updated=1` pro rodičovský doklad
(nejde o samostatný počet měněných položek). Vstup obsahoval nová členění.
GET před a po
testu vrátil nezměněná data. To dokládá CAS a simulaci v dané instanci,
nikoli provedenou opravu. Přesný JSON tvar dry-run je pozorováním instance,
nikoli univerzální zárukou pro všechny verze ABRA.

## 4. Co není doloženo jako samostatné přegenerování zaúčtování

V prohledané oficiální API dokumentaci nebyla nalezena samostatná akce
pro přegenerování zaúčtování již existující přijaté faktury. Běžné uložení
může prostřednictvím reakcí na změnu upravit odvozená data; správnost
zaúčtování je však nutné doložit výsledkem a účetním deníkem.

`rozuctujDoklad` vytváří položky rozúčtování a není doložen jako obecná
regenerace stávajících položek. `zauctovat-prodejky` se týká prodejek.
`/stav-uctu/prepocet` je přepočet zůstatků účtů, nikoli oprava jedné
faktury; jeho parametr `dry-run` má jiný význam než simulace importu.
Žádný z těchto mechanismů nepoužít jako náhradu nedoložené akce.

Zdroje: [oficiální API rozcestník](https://demo.flexibee.eu/devdoc/),
[rozúčtování dokladu](https://demo.flexibee.eu/devdoc/rozuctovani-dokladu),
[přepočet účtů](https://demo.flexibee.eu/devdoc/prepocet-uctu),
[reakce na skutečnou změnu](https://podpora.flexibee.eu/cs/articles/4726038-predchozi-hodnota-zpusob-reakce-na-zmenu).

## 5. Podmíněné pravidlo pro službu od dodavatele z EU

Následující pravidlo předpokládá, že odběratel je plátce DPH s plným
nárokem na odpočet; tento stav je nutné ověřit pro konkrétní firmu.
Samotné sídlo dodavatele v Irsku neznamená nulovou českou DPH.

Pokud jde o službu podle obecného B2B pravidla § 9 odst. 1 ZDPH,
přijatou pro podnikání českého odběratele od osoby registrované k DPH
v jiném členském státě, která není pro dané plnění usazena v tuzemsku,
místo plnění je u odběratele v ČR. Příjemce přizná českou daň; rozhodné
datum je třeba určit podle § 24 včetně případné dřívější úplaty.
Finanční správa tuto logiku výslovně popisuje také u nákupu Google
Workspace v odpovědi z 21. 7. 2026. Tento příklad sám neprokazuje povahu
jiného produktu nebo registračního poplatku.

Zdroj: [Finanční správa: Google Workspace a přijatá zahraniční služba](https://app.fs.gov.cz/dotazy-verejnosti/dotaz/nakup-sluzby-google-workspace-od-osoby-neusazene-v-tuzemsku-%E2%80%93-povinnost-registrace-jako-identifikovana-osoba-5063),
[ZDPH v e-Sbírce](https://e-sbirka.gov.cz/sb/2004/235).

Při základní sazbě patří taková služba do řádku 5 přiznání a příslušný
oprávněný odpočet do řádku 43; při snížené sazbě jde o řádky 6 a 44.
Řádky 7 a 8 se týkají dovozu zboží podle § 23. Pro plátce se přijatá
služba tohoto typu vykazuje v části A.2 kontrolního hlášení, nikoli
v části B.2/B.3 pro běžná tuzemská přijatá plnění.

Zdroje: [Pokyny MFin 5412, vzor 22, strany 2–3; primární formulář FS na vládním BusinessInfo](https://cdn.businessinfo.cz/businessinfo/2025/01/242051bb-fs-priznani-dph-pokyny-5412-22.pdf),
[aktuální katalog formulářů FS](https://financnisprava.gov.cz/cs/dane/danove-tiskopisy),
[EPO: změny 2026 a vzor 22](https://adisspr.mfcr.cz/adis/jepo/temp/readme.htm),
[oficiální pokyny ke KH, část A.2](https://financnisprava.gov.cz/assets/cs/prilohy/d-placeni-dani/Pokyny_k_vyplneni_elektronickeho_formulare_kontrolniho_hlase.pdf).
Odkázané PDF pokynů ke KH je starší vzor 1; katalog aktuálně uvádí vzor 4.
Nelze je označovat za nejnovější pokyny, byť popsané zařazení A.2 odpovídá
ověřované kategorii plnění.

Odlišný režim by měl neplátce, který se přijetím služby stane
identifikovanou osobou: přizná a zaplatí daň, ale nemá z tohoto titulu
nárok na odpočet a nepodává KH. Nelze proto sdílet výchozí režim mezi
firmami ani odvozovat plátcovství z právní formy společnosti.

Zdroje: [FS: identifikované osoby a odpočet](https://financnisprava.gov.cz/cs/mezinarodni-spoluprace/mezinarodni-spoluprace-a-dph/informace-pro-platce-dph-k-vybranym-ustanovenim-zakona),
[FS: kdo podává kontrolní hlášení](https://financnisprava.gov.cz/cs/dane/dane/dan-z-pridane-hodnoty/kontrolni-hlaseni-DPH/kdo-podava-kontrolni-hlaseni).

## 6. Ověření konkrétní firmy a dokladu

Před opravou je nutné v číselnících konkrétní firmy ověřit význam členění
DPH a KH. Interní identifikátory jsou lokální firmě; nesmějí se přenášet
jako globální konstanty do jiné firmy nebo serveru.

Závazek ve výši základu spolu se samovyměřenou daní může být u reverse
charge správný. Pouhé přičtení samovyměřené DPH k závazku není odůvodněná
oprava. U základní sazby a plného odpočtu může být nutná jen oprava
klasifikace a návazností, nikoli změna ceny nebo sazby na nulu.

Před uzavřením kontroly ověřit původní doklad nebo smluvní podklad,
přesný typ služby, případné výjimky z obecného místa plnění,
relevantní usazení dodavatele a okamžik vzniku povinnosti přiznat daň.
Dále zjistit, zda již bylo podáno přiznání nebo KH za dotčené období.
Úprava evidence sama nepodává následné KH ani dodatečné přiznání.

Při popsaném ověření nebyla oprava uložena a nebylo provedeno žádné
daňové podání. Právní závěry výše pocházejí z odkazovaných oficiálních
zdrojů, nikoli z tvrzení, že interní právní korpus MCP je kompletní.
