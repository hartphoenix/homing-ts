export type EvidenceStatus = "PASS" | "FAIL" | "SKIP" | "HARNESS_ERROR";

export type HarnessResult = {
  schema: 1;
  harnessVersion: 1;
  runId: string;
  tier: "A" | "B" | "C" | "D" | "E";
  persona: string;
  containment: string;
  architecture: string;
  locale: string;
  timezone: string;
  allowedEnvironmentNames: string[];
  calibration: EvidenceStatus;
  product: EvidenceStatus;
  productResidue: EvidenceStatus;
  harnessCleanup: EvidenceStatus;
  boundaryAudit: EvidenceStatus;
  claims: Array<{ claim: string; status: EvidenceStatus; reason?: string }>;
  cleanupProvenance: Array<"product" | "harness" | "container" | "vm">;
};
