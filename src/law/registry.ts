export const LAW_REGIMES = ['accounting', 'tax_evidence'] as const;
export type LawRegime = typeof LAW_REGIMES[number];

export const LAW_TOPICS = [
  'records', 'invoicing', 'vat', 'income_tax', 'assets', 'inventory', 'year_end', 'retention',
] as const;
export type LawTopic = typeof LAW_TOPICS[number];

export const SOURCE_KINDS = ['law', 'decree', 'accounting_standard', 'guidance'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];

export const OFFICIAL_HOSTS = [
  'e-sbirka.gov.cz', 'mfcr.cz', 'www.mfcr.cz', 'financnisprava.gov.cz',
] as const;

export interface OfficialSource {
  id: string;
  title: string;
  sourceKind: SourceKind;
  officialUrl: string;
  regimes: readonly LawRegime[];
  topics: readonly LawTopic[];
}

// Discovery metadata only. These links do not assert applicability, completeness,
// effective dates or current wording. No normative text is bundled.
const sources: readonly OfficialSource[] = [
  {
    id: 'accounting-act', title: 'Zákon č. 563/1991 Sb., o účetnictví',
    sourceKind: 'law', officialUrl: 'https://e-sbirka.gov.cz/sb/1991/563',
    regimes: ['accounting'], topics: ['records', 'invoicing', 'assets', 'inventory', 'year_end', 'retention'],
  },
  {
    id: 'entrepreneurs-decree', title: 'Vyhláška č. 500/2002 Sb.',
    sourceKind: 'decree', officialUrl: 'https://e-sbirka.gov.cz/sb/2002/500',
    regimes: ['accounting'], topics: ['records', 'assets', 'inventory', 'year_end'],
  },
  {
    id: 'income-tax-act', title: 'Zákon č. 586/1992 Sb., o daních z příjmů',
    sourceKind: 'law', officialUrl: 'https://e-sbirka.gov.cz/sb/1992/586',
    regimes: ['accounting', 'tax_evidence'], topics: ['records', 'income_tax', 'assets', 'retention'],
  },
  {
    id: 'vat-act', title: 'Zákon č. 235/2004 Sb., o dani z přidané hodnoty',
    sourceKind: 'law', officialUrl: 'https://e-sbirka.gov.cz/sb/2004/235',
    regimes: ['accounting', 'tax_evidence'], topics: ['invoicing', 'vat', 'retention'],
  },
  {
    id: 'accounting-standards', title: 'České účetní standardy pro podnikatele – rozcestník MF',
    sourceKind: 'accounting_standard',
    officialUrl: 'https://www.mfcr.cz/cs/dane-a-ucetnictvi/ucetnictvi-a-ucetnictvi-statu/ucetnictvi-podnikatelu-a-neziskoveho-sek/ceske-ucetni-standardy-pro-podnikatele-a',
    regimes: ['accounting'], topics: ['records', 'assets', 'inventory', 'year_end'],
  },
  {
    id: 'self-employed-guidance', title: 'Finanční správa – podnikatel (OSVČ)',
    sourceKind: 'guidance',
    officialUrl: 'https://financnisprava.gov.cz/cs/dane/dane/dan-z-prijmu/fyzicke-osoby/podnikatel-osvc',
    regimes: ['tax_evidence'], topics: ['records', 'income_tax', 'assets'],
  },
];

export function officialSourceRegistry(): OfficialSource[] {
  return structuredClone(sources) as OfficialSource[];
}
