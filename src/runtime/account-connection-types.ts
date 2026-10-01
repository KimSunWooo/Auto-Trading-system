/** Client-safe account connection issue types (no server imports). */
export type AccountConnectionIssueCode =
  | "ACCOUNT_NOT_CONNECTED"
  | "ACCOUNT_SELECTION_REQUIRED"
  | "MULTIPLE_DEFAULT_ACCOUNTS"
  | "ACCOUNT_FINGERPRINT_MISSING"
  | "CREDENTIAL_MISSING"
  | "CREDENTIAL_DECRYPT_FAILED"
  | "RUNTIME_RESOLUTION_FAILED";

export type AccountConnectionIssue = {
  code: AccountConnectionIssueCode;
  message: string;
};
