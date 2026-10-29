export type ClientRateAgreement = {
  id: string
  clientId?: string
  userId: string | null
  role?: 'CFO' | 'Accountant' | 'Bookkeeper' | null
  effectivePeriod: string
  rate: number | null
  note: string
  revision?: number
  createdAt?: string | null
  createdBy?: string | null
}
export declare function clientRateOverrideAt(client: { billingMode?: string; hourlyRateOverrides?: readonly ClientRateAgreement[] } | null | undefined, employeeId: string | null | undefined, period: string | null | undefined, employeeRole?: string | null): number | null
export declare function validateClientRateAgreement(input: ClientRateAgreement): ClientRateAgreement
