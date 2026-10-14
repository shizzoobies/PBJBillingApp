export function coveredByMasterSentence(clientName: string, masterName: string): string
export function masterDidNotGoSentence(clientName: string, masterName: string): string
export function masterUnsureSentence(clientName: string, masterName: string): string
export function reconcileCoveredResults<
  T extends { clientId: string; status: string; code?: string; message?: string; clientName?: string | null; masterId?: string; masterName?: string },
>(results: T[], options?: { missingMasterDidNotGo?: boolean }): T[]
