/**
 * Read-only post-login PAPER connection probe.
 * Never places orders or enables autoTrading.
 */
import { requireUser } from "@/src/auth/guards";
import { loadPaperSecretForAccount } from "@/src/auth/paper-accounts";
import { getUserAccountBindings } from "@/src/auth/user-account-prefs";
import {
  selectOwnedPaperAccount,
  PaperAccountSelectionError,
} from "@/src/auth/select-paper-account";
import { KisClient } from "@/src/brokers/kis-client";
import { kisConfigFromPaperCredentials } from "@/src/brokers/kis-config";
import {
  classifyAccountConnectionError,
  type AccountConnectionIssue,
} from "@/src/runtime/resolve-trading-runtime";
import { ensureAuthSchema } from "@/src/auth/ensure-schema";

export type AccountConnectionStatus = {
  sessionOk: true;
  userId: string;
  email: string;
  paper: Awaited<ReturnType<typeof getUserAccountBindings>>["paper"];
  real: Awaited<ReturnType<typeof getUserAccountBindings>>["real"];
  connection: {
    ok: boolean;
    issue: AccountConnectionIssue | null;
    brokerAccountId: string | null;
    accountNumberMasked: string | null;
    credentialsStored: boolean;
    credentialsDecryptOk: boolean | null;
    kisBalanceOk: boolean | null;
    realOrdersLocked: true;
  };
};

export async function probeCurrentUserPaperConnection(opts?: {
  /** When true, perform read-only KIS inquireBalance if decrypt works. */
  probeKis?: boolean;
}): Promise<AccountConnectionStatus> {
  await ensureAuthSchema();
  const user = await requireUser();
  const bindings = await getUserAccountBindings(user.id);
  const probeKis = opts?.probeKis !== false;

  const base = {
    sessionOk: true as const,
    userId: user.id,
    email: user.email,
    paper: bindings.paper,
    real: {
      ...bindings.real,
      // REAL never reports trading connection here.
      kisConnected: null,
    },
  };

  try {
    const account = await selectOwnedPaperAccount(user.id);
    const secret = await loadPaperSecretForAccount(account.id);
    if (!secret) {
      return {
        ...base,
        paper: { ...bindings.paper, credentialsDecryptOk: false, brokerAccountId: account.id },
        connection: {
          ok: false,
          issue: {
            code: "CREDENTIAL_MISSING",
            message: "Encrypted PAPER credentials not found",
          },
          brokerAccountId: account.id,
          accountNumberMasked: account.accountNumberMasked,
          credentialsStored: false,
          credentialsDecryptOk: false,
          kisBalanceOk: null,
          realOrdersLocked: true,
        },
      };
    }

    let kisBalanceOk: boolean | null = null;
    let issue: AccountConnectionIssue | null = null;
    if (probeKis) {
      try {
        const client = new KisClient(kisConfigFromPaperCredentials(secret), globalThis.fetch);
        await client.inquireBalance();
        kisBalanceOk = true;
      } catch (err) {
        kisBalanceOk = false;
        issue = {
          code: "RUNTIME_RESOLUTION_FAILED",
          message: err instanceof Error ? err.message : "KIS read-only probe failed",
        };
      }
    }

    return {
      ...base,
      paper: {
        ...bindings.paper,
        brokerAccountId: account.id,
        accountNumberMasked: account.accountNumberMasked,
        credentialsDecryptOk: true,
        appKeyRegistered: true,
        appSecretRegistered: true,
        kisConnected: kisBalanceOk,
      },
      connection: {
        ok: kisBalanceOk !== false,
        issue,
        brokerAccountId: account.id,
        accountNumberMasked: account.accountNumberMasked,
        credentialsStored: true,
        credentialsDecryptOk: true,
        kisBalanceOk,
        realOrdersLocked: true,
      },
    };
  } catch (err) {
    if (
      /BROKER_CREDENTIAL_MASTER_KEY|auth tag|Unsupported state|Invalid credential|decrypt|bad decrypt/i.test(
        err instanceof Error ? err.message : "",
      )
    ) {
      return {
        ...base,
        paper: {
          ...bindings.paper,
          credentialsDecryptOk: false,
        },
        connection: {
          ok: false,
          issue: {
            code: "CREDENTIAL_DECRYPT_FAILED",
            message: "Stored credentials could not be decrypted with the runtime master key",
          },
          brokerAccountId: bindings.paper.brokerAccountId,
          accountNumberMasked: bindings.paper.accountNumberMasked,
          credentialsStored: Boolean(bindings.paper.appKeyRegistered),
          credentialsDecryptOk: false,
          kisBalanceOk: null,
          realOrdersLocked: true,
        },
      };
    }
    const classified = classifyAccountConnectionError(err);
    if (classified) {
      return {
        ...base,
        connection: {
          ok: false,
          issue: classified,
          brokerAccountId: bindings.paper.brokerAccountId,
          accountNumberMasked: bindings.paper.accountNumberMasked,
          credentialsStored: Boolean(bindings.paper.appKeyRegistered),
          credentialsDecryptOk: bindings.paper.credentialsDecryptOk,
          kisBalanceOk: null,
          realOrdersLocked: true,
        },
      };
    }
    if (err instanceof PaperAccountSelectionError) {
      return {
        ...base,
        connection: {
          ok: false,
          issue: { code: err.code, message: err.message },
          brokerAccountId: bindings.paper.brokerAccountId,
          accountNumberMasked: bindings.paper.accountNumberMasked,
          credentialsStored: Boolean(bindings.paper.appKeyRegistered),
          credentialsDecryptOk: bindings.paper.credentialsDecryptOk,
          kisBalanceOk: null,
          realOrdersLocked: true,
        },
      };
    }
    throw err;
  }
}
