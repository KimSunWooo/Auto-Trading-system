"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type AccountRow = {
  id: string;
  displayName: string;
  accountNumberMasked: string | null;
  environment: string;
  appKeyRegistered: boolean;
  appSecretRegistered: boolean;
  status: string;
};

type BindingView = {
  environment: "PAPER" | "REAL";
  brokerAccountId: string | null;
  accountNumberMasked: string | null;
  status: string | null;
  displayName: string | null;
  appKeyRegistered: boolean;
  appSecretRegistered: boolean;
  keyVersion: string | null;
  credentialsDecryptOk: boolean | null;
  kisConnected: boolean | null;
  needsSelection: boolean;
  candidateCount: number;
};

type MeResponse = {
  user: {
    id: string;
    email: string;
    displayName: string;
    role: string;
  } | null;
  accounts?: AccountRow[];
  bindings?: {
    paper: BindingView;
    real: BindingView;
  };
};

type EnvForm = {
  alias: string;
  accountNo: string;
  appKey: string;
  appSecret: string;
};

const emptyForm = (alias: string): EnvForm => ({
  alias,
  accountNo: "",
  appKey: "",
  appSecret: "",
});

export default function MyPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [paperForm, setPaperForm] = useState<EnvForm>(emptyForm("내 PAPER 계좌"));
  const [realForm, setRealForm] = useState<EnvForm>(emptyForm("내 REAL 계좌"));
  const [paperRotate, setPaperRotate] = useState({ accountNo: "", appKey: "", appSecret: "" });
  const [realRotate, setRealRotate] = useState({ accountNo: "", appKey: "", appSecret: "" });

  async function refresh() {
    const res = await fetch("/api/auth/me");
    if (res.status === 401) {
      setMe({ user: null });
      return;
    }
    const body = (await res.json()) as MeResponse;
    setMe(body);
    if (body.user?.displayName) setDisplayName(body.user.displayName);
  }

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : "load failed"));
  }, []);

  const paperAccounts = (me?.accounts ?? []).filter(
    (a) => String(a.environment).toUpperCase() === "PAPER",
  );
  const realAccounts = (me?.accounts ?? []).filter(
    (a) => String(a.environment).toUpperCase() === "REAL",
  );
  const preferredPaperId = me?.bindings?.paper.brokerAccountId ?? null;
  const preferredRealId = me?.bindings?.real.brokerAccountId ?? null;
  const defaultPaper =
    paperAccounts.find((a) => a.id === preferredPaperId) ??
    paperAccounts.find((a) => a.status === "ACTIVE") ??
    paperAccounts[0];
  const defaultReal =
    realAccounts.find((a) => a.id === preferredRealId) ??
    realAccounts.find((a) => a.status === "ACTIVE") ??
    realAccounts[0];

  async function selectPreferred(environment: "PAPER" | "REAL", brokerAccountId: string) {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/accounts/defaults", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environment, brokerAccountId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "선택 실패");
      setMessage(body.note ?? "기본 계좌가 저장되었습니다.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "선택 실패");
    } finally {
      setBusy(false);
    }
  }

  async function connectEnv(
    e: React.FormEvent,
    environment: "PAPER" | "REAL",
    form: EnvForm,
  ) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const path = environment === "PAPER" ? "/api/accounts/paper" : "/api/accounts/real";
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, environment }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "connect failed");
      setMessage(body.note ?? "연결됨");
      if (environment === "PAPER") setPaperForm(emptyForm("내 PAPER 계좌"));
      else setRealForm(emptyForm("내 REAL 계좌"));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "connect failed");
    } finally {
      setBusy(false);
    }
  }

  async function updateEnv(
    e: React.FormEvent,
    environment: "PAPER" | "REAL",
    accountId: string,
    rotate: { accountNo: string; appKey: string; appSecret: string },
  ) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const path =
        environment === "PAPER"
          ? `/api/accounts/paper/${accountId}`
          : `/api/accounts/real/${accountId}`;
      const res = await fetch(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rotate),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "update failed");
      setMessage(
        body.mode === "switch"
          ? `계좌 변경 완료 (새 ID ${body.brokerAccountId}). 이전 계좌 이력은 보존됩니다.`
          : (body.note ?? "인증정보 수정 완료"),
      );
      if (environment === "PAPER") setPaperRotate({ accountNo: "", appKey: "", appSecret: "" });
      else setRealRotate({ accountNo: "", appKey: "", appSecret: "" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "update failed");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  async function saveDisplayName(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/auth/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "profile update failed");
      setMessage("표시 이름이 저장되었습니다.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "profile update failed");
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/auth/password", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "password change failed");
      setMessage("비밀번호가 변경되었습니다.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "password change failed");
    } finally {
      setBusy(false);
    }
  }

  if (!me) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <p className="text-muted-foreground">불러오는 중…</p>
      </main>
    );
  }

  if (!me.user) {
    return (
      <main className="mx-auto max-w-xl space-y-4 p-8">
        <h1 className="text-2xl font-semibold">마이페이지</h1>
        <p className="text-muted-foreground">로그인이 필요합니다.</p>
        <Link href="/login" className="underline">
          로그인
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 p-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">미리매수</p>
          <h1 className="text-2xl font-semibold">마이페이지</h1>
          <p className="text-sm text-muted-foreground">{me.user.email}</p>
        </div>
        <button type="button" className="text-sm underline" onClick={() => void logout()}>
          로그아웃
        </button>
      </header>

      <p className="text-sm text-muted-foreground">
        KIS APP KEY·SECRET은 이 화면에서만 등록합니다. 운영용{" "}
        <code className="text-xs">BROKER_CREDENTIAL_MASTER_KEY</code>는 서버에서만 관리하며 입력하지
        않습니다.
      </p>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">계좌 조회 상태</h2>
        <p className="text-sm text-muted-foreground">
          저장 여부(암호문 존재)와 실제 KIS 연결 성공은 구분됩니다. 키 원문은 표시하지 않습니다.
        </p>
        <BindingCard title="PAPER" binding={me.bindings?.paper ?? null} />
        <BindingCard title="REAL (주문 LOCKED)" binding={me.bindings?.real ?? null} />
        {me.bindings?.paper.needsSelection || (paperAccounts.filter((a) => a.status === "ACTIVE").length > 1) ? (
          <div className="space-y-2">
            <p className="text-sm text-amber-200">PAPER 기본 계좌를 선택하세요.</p>
            {paperAccounts
              .filter((a) => a.status === "ACTIVE")
              .map((a) => (
                <button
                  key={a.id}
                  type="button"
                  disabled={busy}
                  className="block w-full rounded border border-border px-3 py-2 text-left text-sm hover:bg-muted/40"
                  onClick={() => void selectPreferred("PAPER", a.id)}
                >
                  {a.displayName} · {a.accountNumberMasked ?? "****"}
                  {preferredPaperId === a.id ? " (선택됨)" : ""}
                </button>
              ))}
          </div>
        ) : null}
        {me.bindings?.real.needsSelection || (realAccounts.filter((a) => a.status === "ACTIVE").length > 1) ? (
          <div className="space-y-2">
            <p className="text-sm text-amber-200">REAL 기본 계좌를 선택하세요.</p>
            {realAccounts
              .filter((a) => a.status === "ACTIVE")
              .map((a) => (
                <button
                  key={a.id}
                  type="button"
                  disabled={busy}
                  className="block w-full rounded border border-border px-3 py-2 text-left text-sm hover:bg-muted/40"
                  onClick={() => void selectPreferred("REAL", a.id)}
                >
                  {a.displayName} · {a.accountNumberMasked ?? "****"}
                  {preferredRealId === a.id ? " (선택됨)" : ""}
                </button>
              ))}
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">프로필</h2>
        <form className="flex flex-col gap-3" onSubmit={(e) => void saveDisplayName(e)}>
          <input
            className="rounded border border-border bg-background px-3 py-2"
            placeholder="표시 이름"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-foreground px-4 py-2 text-background disabled:opacity-50"
          >
            표시 이름 저장
          </button>
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">비밀번호 변경</h2>
        <form className="flex flex-col gap-3" onSubmit={(e) => void changePassword(e)}>
          <input
            className="rounded border border-border bg-background px-3 py-2"
            placeholder="현재 비밀번호"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
          <input
            className="rounded border border-border bg-background px-3 py-2"
            placeholder="새 비밀번호"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={8}
          />
          <input
            className="rounded border border-border bg-background px-3 py-2"
            placeholder="새 비밀번호 확인"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-foreground px-4 py-2 text-background disabled:opacity-50"
          >
            비밀번호 변경
          </button>
        </form>
      </section>

      <AccountSection
        title="PAPER 계좌"
        subtitle="모의투자 주문·자동매매에 사용합니다. 저장 전 읽기 전용 잔고 조회를 수행합니다."
        accounts={paperAccounts}
        form={paperForm}
        setForm={setPaperForm}
        rotate={paperRotate}
        setRotate={setPaperRotate}
        defaultAccount={defaultPaper}
        busy={busy}
        onConnect={(e) => void connectEnv(e, "PAPER", paperForm)}
        onUpdate={(e, id) => void updateEnv(e, "PAPER", id, paperRotate)}
        lockedNote={null}
      />

      <AccountSection
        title="REAL 계좌"
        subtitle="실전 계좌는 등록·읽기 전용 연결 확인만 지원합니다. 주문·자동매매는 잠겨 있습니다."
        accounts={realAccounts}
        form={realForm}
        setForm={setRealForm}
        rotate={realRotate}
        setRotate={setRealRotate}
        defaultAccount={defaultReal}
        busy={busy}
        onConnect={(e) => void connectEnv(e, "REAL", realForm)}
        onUpdate={(e, id) => void updateEnv(e, "REAL", id, realRotate)}
        lockedNote="REAL 주문·자동매매 LOCKED"
      />

      {message ? <p className="text-sm text-emerald-400">{message}</p> : null}
      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      <p className="text-sm text-muted-foreground">
        <Link href="/" className="underline">
          대시보드
        </Link>
      </p>
    </main>
  );
}

function BindingCard({ title, binding }: { title: string; binding: BindingView | null }) {
  if (!binding) {
    return (
      <div className="rounded border border-border p-3 text-sm text-muted-foreground">
        {title}: 불러오는 중…
      </div>
    );
  }
  return (
    <div className="rounded border border-border p-3 text-sm">
      <div className="font-medium">{title}</div>
      <div>계좌: {binding.accountNumberMasked ?? "—"}</div>
      <div>상태: {binding.status ?? "—"}</div>
      <div>APP KEY 저장: {binding.appKeyRegistered ? "registered" : "missing"}</div>
      <div>APP SECRET 저장: {binding.appSecretRegistered ? "registered" : "missing"}</div>
      <div>key_version: {binding.keyVersion ?? "—"}</div>
      <div>
        복호화:{" "}
        {binding.credentialsDecryptOk == null
          ? "—"
          : binding.credentialsDecryptOk
            ? "ok"
            : "failed"}
      </div>
      <div>
        KIS 연결:{" "}
        {binding.kisConnected == null ? "미확인" : binding.kisConnected ? "ok" : "failed"}
      </div>
    </div>
  );
}

function AccountSection(props: {
  title: string;
  subtitle: string;
  accounts: AccountRow[];
  form: EnvForm;
  setForm: (f: EnvForm) => void;
  rotate: { accountNo: string; appKey: string; appSecret: string };
  setRotate: (r: { accountNo: string; appKey: string; appSecret: string }) => void;
  defaultAccount?: AccountRow;
  busy: boolean;
  onConnect: (e: React.FormEvent) => void;
  onUpdate: (e: React.FormEvent, id: string) => void;
  lockedNote: string | null;
}) {
  const {
    title,
    subtitle,
    accounts,
    form,
    setForm,
    rotate,
    setRotate,
    defaultAccount,
    busy,
    onConnect,
    onUpdate,
    lockedNote,
  } = props;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">{title}</h2>
      <p className="text-sm text-muted-foreground">{subtitle}</p>
      {lockedNote ? (
        <p className="text-sm font-medium text-amber-400">{lockedNote}</p>
      ) : null}

      {accounts.length === 0 ? (
        <p className="text-muted-foreground">연결된 계좌가 없습니다.</p>
      ) : (
        <ul className="space-y-2">
          {accounts.map((a) => (
            <li key={a.id} className="rounded border border-border p-3 text-sm">
              <div className="font-medium">{a.displayName}</div>
              <div>계좌: {a.accountNumberMasked ?? "****"}</div>
              <div>환경: {a.environment}</div>
              <div>APP KEY: {a.appKeyRegistered ? "registered" : "missing"}</div>
              <div>APP SECRET: {a.appSecretRegistered ? "registered" : "missing"}</div>
              <div>상태: {a.status}</div>
            </li>
          ))}
        </ul>
      )}

      {accounts.length === 0 ? (
        <form className="flex flex-col gap-3" onSubmit={onConnect}>
          <input
            className="rounded border border-border bg-background px-3 py-2"
            placeholder="별칭"
            value={form.alias}
            onChange={(e) => setForm({ ...form, alias: e.target.value })}
          />
          <input
            className="rounded border border-border bg-background px-3 py-2"
            placeholder="계좌번호"
            value={form.accountNo}
            onChange={(e) => setForm({ ...form, accountNo: e.target.value })}
            required
          />
          <input
            className="rounded border border-border bg-background px-3 py-2"
            placeholder="APP KEY"
            value={form.appKey}
            onChange={(e) => setForm({ ...form, appKey: e.target.value })}
            required
          />
          <input
            className="rounded border border-border bg-background px-3 py-2"
            placeholder="APP SECRET"
            type="password"
            value={form.appSecret}
            onChange={(e) => setForm({ ...form, appSecret: e.target.value })}
            required
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-foreground px-4 py-2 text-background disabled:opacity-50"
          >
            {busy ? "검증 중…" : "연결 확인 후 저장"}
          </button>
        </form>
      ) : defaultAccount ? (
        <form className="flex flex-col gap-3" onSubmit={(e) => onUpdate(e, defaultAccount.id)}>
          <p className="text-sm text-muted-foreground">
            동일 계좌번호면 KEY·SECRET만 교체합니다. 다른 계좌번호면 새 행을 만들고 이전 계좌는
            DISABLED로 보존합니다.
          </p>
          <input
            className="rounded border border-border bg-background px-3 py-2"
            placeholder="계좌번호"
            value={rotate.accountNo}
            onChange={(e) => setRotate({ ...rotate, accountNo: e.target.value })}
            required
          />
          <input
            className="rounded border border-border bg-background px-3 py-2"
            placeholder="APP KEY"
            value={rotate.appKey}
            onChange={(e) => setRotate({ ...rotate, appKey: e.target.value })}
            required
          />
          <input
            className="rounded border border-border bg-background px-3 py-2"
            placeholder="APP SECRET"
            type="password"
            value={rotate.appSecret}
            onChange={(e) => setRotate({ ...rotate, appSecret: e.target.value })}
            required
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-foreground px-4 py-2 text-background disabled:opacity-50"
          >
            {busy ? "검증 중…" : "저장"}
          </button>
        </form>
      ) : null}
    </section>
  );
}
