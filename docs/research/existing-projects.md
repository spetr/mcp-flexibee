# Prostudované implementace

Ověřeno proti staženým archivům 2026-10-26. Archivy pro rešerši jsou pouze
v `/tmp/flexi-research.TUbCpU`; cizí projekt není závislostí našeho serveru a
jeho zdrojové moduly nejsou vendorizované. Následující závěry se týkají těchto
snapshotů, nikoli automaticky aktuálních default branches.

| Projekt | Ověřený stack | Vliv na náš návrh |
|---|---|---|
| [mcp-open/abra-flexi-mcp, dev](https://github.com/mcp-open/abra-flexi-mcp/tree/dev) | Python, FastMCP 2, MIT LICENSE | Strukturované filtry, omezené evidence, datová minimalizace |
| [vvitovec/abra-flexi-mcp-server](https://github.com/vvitovec/abra-flexi-mcp-server) | TypeScript, MCP SDK v1.29 | Oddělení čtení, dry-run a budoucích potvrzených zápisů |
| [vvitovec/abra-flexi-chatgpt-app](https://github.com/vvitovec/abra-flexi-chatgpt-app) | TypeScript, remote MCP/OAuth | Oddělení identity, připojení a firmy v budoucím remote deploymentu |
| [VitexSoftware/mcp-server-abraflexi](https://github.com/VitexSoftware/mcp-server-abraflexi) | Python, FastMCP, python-abraflexi | Přehled pokrytí Flexi a scénářů; náš veřejný tool surface zůstává úzký |
| [anaryk/abra-flexi-cloud-mcp](https://github.com/anaryk/abra-flexi-cloud-mcp) | TypeScript, MCP SDK v1.12, MIT LICENSE | Jednoduchý stdio základ; boolean confirm není dostatečný návrh pro budoucí zápisy |

LobeHub snapshot původního projektu LukasOrcik uvádí jiný stack a licenci než
stažený současný `mcp-open` dev branch. Pro implementační rozhodnutí proto
vycházíme z konkrétního repozitáře a jeho licence.

Oba archivy vvitovec neobsahovaly explicitní LICENSE ani `license` v package.json.
Sloužily k inspekci chování; jejich kód jsme nepřebírali. Vitex deklaruje MIT
v pyproject.toml, samostatný LICENSE v tomto archivu chyběl. Právní oprávnění
k případnému budoucímu převzetí kódu se musí ověřit samostatně.

## Identita stažených archivů

| Lokální archiv | SHA-256 |
|---|---|
| `lukas-mcp.tar.gz` | `ab1d92717a32c5fdfe32d644a663dfaae0c46b016a1933ea46b02ba698713742` |
| `vvitovec-mcp.tar.gz` | `dbbf17044a92b399aa19c9f7ad3903b083538220b74b618dbd53070d85abc127` |
| `vvitovec-app.tar.gz` | `ad6fde1bfa807ae7a98f3dca6d7605dc67bffc4b3b33761f72ebebae0955432e` |
| `vitex.tar.gz` | `7766bf6c9695b5d1b07c9d933ee4627af23f3d5eb375209e20206a2fb487710c` |
| `anaryk.tar.gz` | `331cf7abb8a144c194424a513aac98b5b8121fff28040ff9ba73393620254e14` |

Archivy slouží jako auditní stopa rešerše; nepouštíme jejich install scripts ani
jejich servery s účetními credentials.
