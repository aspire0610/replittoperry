import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Link } from "wouter";
import { ArrowLeft, ArrowUpRight, Check, ChevronLeft, ChevronRight, CircleAlert, Copy, KeyRound, LoaderCircle, Search, ShieldCheck, UserPlus, Users, X } from "lucide-react";
import { SignIn, SignUp, useAuth } from "@clerk/react";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  getGetAdminUsersQueryKey,
  useDeleteAdminUser,
  useGetAdminUsers,
  usePatchAdminUser,
  usePostAdminInvitation,
  usePostAdminWebSearchDiagnostic,
  type AdminUser,
  type AdminUserUpdate,
} from "@workspace/api-client-react";

const PAGE_SIZE = 25;
const appBasePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const appRoute = (path: string) => `${appBasePath}${path.startsWith("/") ? path : `/${path}`}`;
const invitationSchema = z.object({
  email: z.string().trim().email("請輸入有效的電子郵件地址。").max(254, "電子郵件地址不可超過 254 個字元。"),
});
type InvitationFormValues = z.infer<typeof invitationSchema>;

function AccountStyles() {
  return (
    <style>{`
      .account-screen {
        --account-ink: #1d2c39;
        --account-muted: #687985;
        --account-line: #d8e1e4;
        --account-paper: #f2f6f5;
        --account-panel: rgba(251, 253, 252, .84);
        --account-teal: #176b66;
        --account-teal-dark: #145550;
        --account-coral: #b84f42;
        min-height: 100dvh; padding: clamp(22px, 5vw, 62px);
        color: var(--account-ink);
        background:
          radial-gradient(ellipse at 87% 7%, rgba(164, 202, 193, .23), transparent 32rem),
          linear-gradient(135deg, #f4f7f5 0%, #eaf1ef 100%);
        font-family: var(--app-font-sans, 'Manrope', 'Noto Sans TC', sans-serif);
      }
      .account-screen * { box-sizing: border-box; }
      .account-wrap { max-width: 1120px; margin: 0 auto; }
      .account-masthead { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding-bottom: 24px; border-bottom: 1px solid rgba(48, 78, 82, .16); }
      .account-brand { display: flex; align-items: center; gap: 12px; color: var(--account-ink); text-decoration: none; }
      .account-brand-mark { width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid rgba(23, 107, 102, .4); border-radius: 9px; color: var(--account-teal); background: rgba(255,255,255,.45); }
      .account-brand strong { display: block; font-size: 13px; letter-spacing: .08em; }
      .account-brand small { display: block; margin-top: 3px; color: var(--account-muted); font-size: 10px; letter-spacing: .02em; }
      .account-masthead-note { display: flex; align-items: center; gap: 7px; color: var(--account-muted); font-size: 11px; }
      .account-masthead-note svg { color: var(--account-teal); }
      .account-main { padding-top: clamp(28px, 5vw, 55px); }
      .account-heading { max-width: 750px; margin-bottom: 27px; }
      .account-eyebrow { margin: 0 0 10px; color: var(--account-teal); font: 700 10px var(--app-font-mono, monospace); letter-spacing: .14em; text-transform: uppercase; }
      .account-heading h1 { margin: 0; font-size: clamp(29px, 4.2vw, 43px); line-height: 1.12; letter-spacing: -.055em; font-weight: 750; }
      .account-heading p:last-child { max-width: 620px; margin: 12px 0 0; color: var(--account-muted); font-size: 13px; line-height: 1.7; }
      .account-panel { overflow: hidden; border: 1px solid rgba(57, 87, 87, .15); border-radius: 12px; background: var(--account-panel); box-shadow: 0 18px 50px rgba(37, 67, 69, .08), inset 0 1px rgba(255,255,255,.8); backdrop-filter: blur(18px); }
      .account-diagnostic { margin-top: 16px; padding: 19px 22px; }
      .account-diagnostic-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
      .account-diagnostic h2 { margin: 0; font-size: 16px; letter-spacing: -.025em; }
      .account-diagnostic p { margin: 6px 0 0; color: var(--account-muted); font-size: 11px; line-height: 1.6; }
      .account-diagnostic-result { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 16px; padding-top: 13px; border-top: 1px solid var(--account-line); color: #53656b; font-size: 11px; }
      .account-diagnostic-result strong { color: var(--account-ink); }
      .account-diagnostic-result.error strong { color: var(--account-coral); }
      .account-toolbar { display: flex; align-items: end; justify-content: space-between; gap: 18px; padding: 19px 22px; border-bottom: 1px solid var(--account-line); }
      .account-toolbar h2 { margin: 0; font-size: 16px; letter-spacing: -.025em; }
      .account-toolbar p { margin: 5px 0 0; color: var(--account-muted); font-size: 11px; }
      .account-count { padding: 5px 9px; border: 1px solid var(--account-line); border-radius: 5px; color: #50636b; font: 11px var(--app-font-mono, monospace); white-space: nowrap; }
      .account-admin-grid { display: grid; grid-template-columns: minmax(0, 1fr) 294px; gap: 16px; align-items: start; }
      .account-users { min-width: 0; }
      .account-controls { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--account-line); }
      .account-search { min-width: 0; flex: 1; display: flex; align-items: center; gap: 9px; height: 39px; padding: 0 11px; border: 1px solid #cbd8da; border-radius: 6px; background: rgba(255,255,255,.65); color: #74848a; }
      .account-search:focus-within { border-color: var(--account-teal); box-shadow: 0 0 0 3px rgba(23,107,102,.1); }
      .account-search input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--account-ink); font: 12px var(--app-font-sans, sans-serif); }
      .account-search input::placeholder { color: #8b999d; }
      .account-button { min-height: 38px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 0 13px; border: 1px solid transparent; border-radius: 5px; font: 700 11px var(--app-font-sans, sans-serif); transition: background .16s ease, transform .16s ease, border-color .16s ease; }
      .account-button:disabled { cursor: not-allowed; opacity: .55; }
      .account-button-primary { color: #f4faf8; background: var(--account-teal); }
      .account-button-primary:hover:not(:disabled) { background: var(--account-teal-dark); transform: translateY(-1px); }
      .account-button-quiet { border-color: var(--account-line); color: #53656b; background: rgba(255,255,255,.45); }
      .account-button-quiet:hover:not(:disabled) { border-color: #9fb6b4; background: #fff; }
      .account-button-danger { border-color: rgba(184,79,66,.26); color: var(--account-coral); background: rgba(184,79,66,.045); }
      .account-table-wrap { overflow-x: auto; }
      .account-table { width: 100%; border-collapse: collapse; text-align: left; }
      .account-table th { padding: 11px 15px; color: #7a898e; font: 700 9px var(--app-font-mono, monospace); letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; background: rgba(237,243,241,.57); }
      .account-table td { padding: 13px 15px; border-top: 1px solid rgba(216,225,228,.72); vertical-align: middle; font-size: 11px; }
      .account-table tr:hover td { background: rgba(237,245,242,.48); }
      .account-person { min-width: 205px; display: flex; align-items: center; gap: 10px; }
      .account-initial { width: 31px; height: 31px; flex: 0 0 auto; display: grid; place-items: center; border: 1px solid #c9dcda; border-radius: 7px; color: var(--account-teal); background: #e9f2ef; font: 700 10px var(--app-font-mono, monospace); }
      .account-person strong { display: block; max-width: 190px; overflow: hidden; color: #293b43; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
      .account-person small { display: block; max-width: 190px; margin-top: 3px; overflow: hidden; color: #78878c; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
      .account-role { padding: 4px 7px; border: 1px solid #d6e2e1; border-radius: 4px; color: #53686a; background: rgba(255,255,255,.56); font-size: 10px; }
      .account-role.admin { border-color: #b7d4cf; color: var(--account-teal); background: #edf6f2; }
      .account-state { display: inline-flex; align-items: center; gap: 6px; color: #447862; font-size: 10px; white-space: nowrap; }
      .account-state::before { width: 6px; height: 6px; border-radius: 50%; background: #4e9a74; content: ""; }
      .account-state.disabled { color: #a45b4e; }
      .account-state.disabled::before { background: #bd6a5e; }
      .account-state.not-invited { color: #8a6a36; }
      .account-state.not-invited::before { background: #b99555; }
      .account-row-actions { display: flex; justify-content: flex-end; gap: 6px; }
      .account-icon-button { min-height: 30px; padding: 0 8px; border: 1px solid transparent; border-radius: 4px; color: #607178; background: transparent; font-size: 10px; white-space: nowrap; }
      .account-icon-button:hover { border-color: var(--account-line); background: rgba(255,255,255,.7); }
      .account-icon-button:disabled { opacity: .5; cursor: not-allowed; }
      .account-date { color: #65777e; font: 10px var(--app-font-mono, monospace); white-space: nowrap; }
      .account-pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 17px; border-top: 1px solid var(--account-line); color: var(--account-muted); font-size: 10px; }
      .account-pager-controls { display: flex; gap: 5px; }
      .account-page-button { width: 30px; height: 28px; display: grid; place-items: center; border: 1px solid var(--account-line); border-radius: 4px; color: #53666d; background: rgba(255,255,255,.5); }
      .account-page-button:disabled { opacity: .4; cursor: not-allowed; }
      .account-invite { padding: 19px; }
      .account-invite-icon { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid #c7ddda; border-radius: 8px; color: var(--account-teal); background: #edf6f3; }
      .account-invite h2 { margin: 13px 0 5px; font-size: 15px; letter-spacing: -.025em; }
      .account-invite > p { margin: 0; color: var(--account-muted); font-size: 11px; line-height: 1.6; }
      .account-form { display: grid; gap: 8px; margin-top: 20px; }
      .account-form label { color: #54666c; font-size: 10px; font-weight: 700; }
      .account-form input { width: 100%; height: 39px; padding: 0 11px; border: 1px solid #cbd8da; border-radius: 5px; outline: none; color: var(--account-ink); background: rgba(255,255,255,.7); font: 12px var(--app-font-sans, sans-serif); }
      .account-form input:focus { border-color: var(--account-teal); box-shadow: 0 0 0 3px rgba(23,107,102,.1); }
      .account-form .account-button { width: 100%; margin-top: 4px; }
      .account-note { margin-top: 17px !important; padding-top: 14px; border-top: 1px solid var(--account-line); font-size: 10px !important; }
      .account-feedback { display: flex; align-items: flex-start; gap: 8px; margin: 12px 18px; padding: 10px 11px; border: 1px solid #c7ded5; border-radius: 5px; color: #356b55; background: #edf7f1; font-size: 11px; line-height: 1.5; }
      .account-feedback.error { border-color: #e6c6be; color: #a2483b; background: #fbefec; }
      .account-feedback svg { flex: 0 0 auto; margin-top: 1px; }
      .account-invitation-link { margin: 0 18px 12px; }
      .account-invitation-link label { display: block; color: #54666c; font-size: 10px; font-weight: 700; }
      .account-invitation-link-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; margin-top: 5px; }
      .account-invitation-link input { width: 100%; min-width: 0; height: 34px; padding: 0 8px; border: 1px solid #cbd8da; border-radius: 4px; outline: none; color: var(--account-ink); background: rgba(255,255,255,.7); font: 10px var(--app-font-mono, monospace); }
      .account-invitation-link input:focus { border-color: var(--account-teal); box-shadow: 0 0 0 2px rgba(23,107,102,.1); }
      .account-invitation-link button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 34px; padding: 0 9px; border: 1px solid var(--account-line); border-radius: 4px; color: #50636b; background: rgba(255,255,255,.65); font-size: 10px; white-space: nowrap; }
      .account-invitation-link button:hover { background: #fff; }
      .account-invitation-link small { display: block; margin-top: 5px; color: var(--account-muted); font-size: 10px; line-height: 1.5; }
      .account-state-card { min-height: 220px; display: grid; place-items: center; padding: 30px; text-align: center; }
      .account-state-card > div { max-width: 360px; }
      .account-state-card strong { display: block; margin-top: 12px; font-size: 13px; }
      .account-state-card p { margin: 6px 0 13px; color: var(--account-muted); font-size: 11px; line-height: 1.6; }
      .account-skeleton { display: grid; gap: 1px; padding: 5px 17px; }
      .account-skeleton span { height: 54px; border-bottom: 1px solid rgba(216,225,228,.7); background: linear-gradient(90deg, rgba(219,230,227,.18), rgba(219,230,227,.52), rgba(219,230,227,.18)); background-size: 200% 100%; animation: account-shimmer 1.5s ease-in-out infinite; }
      @keyframes account-shimmer { to { background-position: -200% 0; } }
      .account-auth-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(330px, 420px); gap: clamp(26px, 6vw, 80px); align-items: center; min-height: calc(100dvh - 120px); }
      .account-auth-copy { max-width: 540px; }
      .account-auth-copy h1 { max-width: 520px; }
      .account-auth-spec { display: grid; gap: 0; max-width: 410px; margin-top: 30px; border-top: 1px solid rgba(48,78,82,.16); }
      .account-auth-spec div { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; padding: 11px 0; border-bottom: 1px solid rgba(48,78,82,.12); }
      .account-auth-spec span { color: var(--account-muted); font-size: 10px; }
      .account-auth-spec strong { color: #43565e; font: 10px var(--app-font-mono, monospace); }
      .account-clerk-panel { min-width: 0; padding: 20px; border: 1px solid rgba(57,87,87,.15); border-radius: 12px; background: rgba(251,253,252,.8); box-shadow: 0 18px 50px rgba(37,67,69,.08); backdrop-filter: blur(18px); }
      .account-back { display: inline-flex; align-items: center; gap: 7px; margin-top: 22px; color: var(--account-teal); text-decoration: none; font-size: 11px; font-weight: 700; }
      .account-back:hover { text-decoration: underline; }
      .account-ticket-notice { max-width: 540px; padding: 21px; border: 1px solid #d0dfdc; border-radius: 9px; background: rgba(255,255,255,.52); }
      .account-ticket-notice > svg { color: var(--account-teal); }
      .account-ticket-notice strong { display: block; margin-top: 12px; font-size: 14px; }
      .account-ticket-notice p { margin: 6px 0 0; color: var(--account-muted); font-size: 12px; line-height: 1.7; }
       .dark .account-screen {
         --account-ink: #e8f0fa; --account-muted: #a9b9cb; --account-line: rgba(193, 213, 237, .17);
         --account-paper: #121c2b; --account-panel: rgba(27, 39, 57, .72);
         --account-teal: #9bc9f4; --account-teal-dark: #c1dfff; --account-coral: #f3a095;
         background:
           radial-gradient(ellipse at 88% 5%, rgba(119, 157, 202, .16), transparent 34rem),
           linear-gradient(145deg, #121c2b 0%, #182538 58%, #101a29 100%);
       }
       .dark .account-screen .account-panel,
       .dark .account-screen .account-clerk-panel {
         border-color: rgba(221, 235, 252, .17);
         background:
           linear-gradient(138deg, rgba(244, 249, 255, .15), rgba(133, 159, 190, .05) 28%, rgba(26, 39, 57, .13) 56%, rgba(222, 235, 250, .07) 78%, rgba(17, 27, 43, .34)),
           var(--account-panel);
         box-shadow: 0 22px 60px rgba(0,0,0,.34), inset 0 1px 0 rgba(240,248,255,.2), inset 0 -1px 0 rgba(124,154,190,.11);
       }
       .dark .account-screen .account-ticket-notice { border-color: var(--account-line); background: rgba(33,48,68,.58); }
       .dark .account-screen .account-count,
       .dark .account-screen .account-role,
       .dark .account-screen .account-icon-button,
       .dark .account-screen .account-page-button { border-color: var(--account-line); color: var(--account-muted); background: rgba(212,228,248,.055); }
       .dark .account-screen .account-role.admin,
       .dark .account-screen .account-initial,
       .dark .account-screen .account-invite-icon { border-color: rgba(153,198,238,.28); color: var(--account-teal); background: rgba(114,164,211,.12); }
       .dark .account-screen .account-search,
       .dark .account-screen .account-form input,
       .dark .account-screen .account-invitation-link input,
       .dark .account-screen .account-invitation-link button { border-color: var(--account-line); color: var(--account-ink); background: rgba(12,21,34,.48); }
       .dark .account-screen .account-search input { color: var(--account-ink); }
       .dark .account-screen .account-table th { color: var(--account-muted); background: rgba(175,200,230,.07); }
       .dark .account-screen .account-table td { border-color: rgba(193,213,237,.11); color: var(--account-ink); }
       .dark .account-screen .account-table tr:hover td { background: rgba(174,202,234,.06); }
       .dark .account-screen .account-person strong { color: var(--account-ink); }
       .dark .account-screen .account-person small,
       .dark .account-screen .account-date,
       .dark .account-screen .account-masthead-note,
       .dark .account-screen .account-auth-spec strong { color: var(--account-muted); }
       .dark .account-screen .account-feedback { border-color: rgba(125,190,158,.28); color: #a9dfbe; background: rgba(43,108,76,.16); }
       .dark .account-screen .account-feedback.error { border-color: rgba(238,145,130,.3); color: #ffc0b2; background: rgba(140,54,48,.16); }
       .dark .account-screen .account-state { color: #9dd8b6; }
       .dark .account-screen .account-state.disabled { color: #f3a095; }
       .dark .account-screen .account-state.not-invited { color: #e9c98e; }
       .dark .account-screen .account-auth-spec,
       .dark .account-screen .account-auth-spec div { border-color: var(--account-line); }
       .dark .account-screen .account-auth-spec span,
       .dark .account-screen .account-invitation-link label,
       .dark .account-screen .account-form label,
       .dark .account-screen .account-note { color: var(--account-muted); }
      @media (max-width: 900px) { .account-admin-grid { grid-template-columns: minmax(0, 1fr); } .account-invite { display: grid; grid-template-columns: 42px minmax(0,1fr); column-gap: 12px; } .account-invite-icon { grid-row: 1 / span 2; } .account-invite h2 { margin-top: 2px; } .account-invite > p { grid-column: 2; } .account-form { grid-column: 1 / -1; grid-template-columns: minmax(0,1fr) auto; align-items: end; } .account-form label { grid-column: 1 / -1; } .account-form .account-button { width: auto; margin: 0; } .account-note { grid-column: 1 / -1; } }
      @media (max-width: 680px) { .account-screen { padding: 18px 14px 34px; } .account-masthead { align-items: flex-start; } .account-masthead-note { max-width: 125px; align-items: flex-start; font-size: 9px; line-height: 1.4; } .account-auth-layout { grid-template-columns: minmax(0,1fr); min-height: 0; gap: 24px; } .account-auth-copy h1 { font-size: 31px; } .account-clerk-panel { padding: 12px; } .account-toolbar { align-items: flex-start; padding: 16px; } .account-controls { padding: 11px; } .account-table { min-width: 710px; } .account-pager { padding-inline: 12px; } .account-invite { display: block; } .account-invite-icon { margin-bottom: 11px; } .account-invite h2 { margin-top: 0; } .account-form { grid-template-columns: minmax(0,1fr); } .account-form .account-button { width: 100%; } }
      @media (prefers-reduced-motion: reduce) { .account-screen *, .account-screen *::before, .account-screen *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
    `}</style>
  );
}

function AccountMasthead() {
  return (
    <header className="account-masthead">
      <Link href="/" className="account-brand" data-testid="link-account-brand">
        <span className="account-brand-mark"><span className="mono">TW</span></span>
        <span><strong>台股分析</strong><small>MARKET RESEARCH DESK</small></span>
      </Link>
      <div className="account-masthead-note"><ShieldCheck size={14} /> 私人研究空間 · 僅限受邀帳戶</div>
    </header>
  );
}

function formatAccountDate(value: string | null | undefined) {
  if (!value) return "尚無紀錄";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日期未提供";
  return new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "目前無法完成請求，請稍後重試。";
}

function adminUserLabel(user: AdminUser) {
  return user.email || `Clerk 帳號 ${user.id}`;
}

function UserRow({ user, busy, currentUserId, onRole, onToggle, onDelete }: {
  user: AdminUser;
  busy: boolean;
  currentUserId?: string;
  onRole: (user: AdminUser) => void;
  onToggle: (user: AdminUser) => void;
  onDelete: (user: AdminUser) => void;
}) {
  const userLabel = adminUserLabel(user);
  const initials = (user.fullName || user.email || user.id).trim().slice(0, 2).toUpperCase();
  const accessLabel = user.banned
    ? user.appAccess === "not_invited"
      ? "已停用 · 未獲邀"
      : "已停用"
    : user.appAccess === "active"
      ? "可使用"
      : "未獲邀";
  const accessClass = user.banned
    ? "disabled"
    : user.appAccess === "not_invited"
      ? "not-invited"
      : "";
  return (
    <tr data-testid={`row-admin-user-${user.id}`}>
      <td><div className="account-person"><span className="account-initial" aria-hidden="true">{initials}</span><span><strong data-testid={`text-user-name-${user.id}`}>{user.fullName || "尚未設定姓名"}</strong><small data-testid={`text-user-email-${user.id}`}>{user.email || `未提供電子郵件 · ${user.id}`}</small></span></div></td>
      <td><span className={`account-role ${user.role}`} data-testid={`text-user-role-${user.id}`}>{user.role === "admin" ? "管理員" : "成員"}</span></td>
      <td><span className={`account-state ${accessClass}`} data-testid={`status-user-access-${user.id}`}>{accessLabel}</span></td>
      <td><span className="account-date" data-testid={`text-user-created-${user.id}`}>{formatAccountDate(user.createdAt)}</span></td>
      <td><span className="account-date" data-testid={`text-user-signin-${user.id}`}>{formatAccountDate(user.lastSignInAt)}</span></td>
      <td><div className="account-row-actions">
        {user.appAccess === "active" && <button type="button" className="account-icon-button" onClick={() => onRole(user)} disabled={busy} data-testid={`button-toggle-role-${user.id}`} aria-label={`變更 ${userLabel} 權限`}>{user.role === "admin" ? "改為成員" : "設為管理員"}</button>}
        <button type="button" className={`account-icon-button ${user.banned ? "" : "account-button-danger"}`} onClick={() => onToggle(user)} disabled={busy} data-testid={`button-toggle-access-${user.id}`}>{user.banned ? "恢復" : "停用"}</button>
        {user.role !== "admin" && user.id !== currentUserId && (
          <button
            type="button"
            className="account-icon-button account-button-danger"
            onClick={() => onDelete(user)}
            disabled={busy}
            data-testid={`button-delete-user-${user.id}`}
            aria-label={`永久刪除 ${userLabel}`}
          >永久刪除</button>
        )}
      </div></td>
    </tr>
  );
}

export function AdminUsersPage() {
  const { userId: currentUserId } = useAuth();
  const [searchInput, setSearchInput] = useState("");
  const [offset, setOffset] = useState(0);
  const [inviteNotice, setInviteNotice] = useState("");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteCopyNotice, setInviteCopyNotice] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [updateNotice, setUpdateNotice] = useState("");
  const [updateError, setUpdateError] = useState("");
  const inviteForm = useForm<InvitationFormValues>({
    resolver: zodResolver(invitationSchema),
    defaultValues: { email: "" },
  });
  const email = inviteForm.watch("email");
  const queryClient = useQueryClient();
  const params = useMemo(() => ({
    ...(searchInput.trim() ? { query: searchInput.trim() } : {}),
    limit: PAGE_SIZE,
    offset,
  }), [searchInput, offset]);
  const usersQuery = useGetAdminUsers(params, {
    query: { queryKey: getGetAdminUsersQueryKey(params), retry: 1 },
    request: { credentials: "include" },
  });
  const inviteMutation = usePostAdminInvitation({ request: { credentials: "include" } });
  const updateMutation = usePatchAdminUser({ request: { credentials: "include" } });
  const deleteMutation = useDeleteAdminUser({ request: { credentials: "include" } });
  const diagnosticMutation = usePostAdminWebSearchDiagnostic({ request: { credentials: "include" } });
  const users = usersQuery.data?.users ?? [];
  const total = usersQuery.data?.totalCount ?? 0;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);
  const diagnosticResult = diagnosticMutation.data;
  const diagnosticProviderLabel = diagnosticResult?.provider === "google_news_rss"
    ? "Google News RSS"
    : diagnosticResult?.provider === "brave"
      ? "Brave Search"
      : diagnosticResult?.provider === "searxng"
        ? "SearXNG"
        : "DuckDuckGo";
  const diagnosticOutcomeLabel = diagnosticResult?.outcome === "searched"
    ? "連線及解析正常"
    : diagnosticResult?.outcome === "empty"
      ? "連線正常，但沒有解析到結果"
      : diagnosticResult?.failureKind === "timeout"
        ? "連線逾時"
        : diagnosticResult?.failureKind === "configuration_error"
          ? "搜尋來源設定尚未完成"
          : diagnosticResult?.failureKind === "http_error"
          ? `${diagnosticProviderLabel} 回傳 HTTP 錯誤`
          : diagnosticResult?.outcome === "failed"
            ? "連線或回應錯誤"
            : "";

  const invite = (values: InvitationFormValues) => {
    const normalizedEmail = values.email.trim().toLowerCase();
    setInviteNotice("");
    setInviteUrl(null);
    setInviteCopyNotice("");
    setInviteError("");
    inviteMutation.mutate({ data: { email: normalizedEmail } }, {
      onSuccess: (invitation) => {
        setInviteNotice(
          invitation.invitationUrl
            ? `已為 ${invitation.email} 建立邀請，並請 Clerk 寄送通知。若對方未收到郵件，可複製下方連結。`
            : `已為 ${invitation.email} 建立邀請，並請 Clerk 寄送通知；目前無法確認郵件是否送達。`,
        );
        setInviteUrl(invitation.invitationUrl);
        inviteForm.reset({ email: "" });
        void queryClient.invalidateQueries({ queryKey: getGetAdminUsersQueryKey() });
      },
      onError: (error) => setInviteError(errorMessage(error)),
    });
  };
  const copyInvitationUrl = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopyNotice("邀請連結已複製，請只轉交給指定收件人。");
    } catch {
      setInviteCopyNotice("無法自動複製，請選取上方連結並手動複製。");
    }
  };
  const dismissInviteNotice = () => {
    setInviteNotice("");
    setInviteUrl(null);
    setInviteCopyNotice("");
  };

  const updateUser = (user: AdminUser, data: AdminUserUpdate, description: string) => {
    setUpdateNotice("");
    setUpdateError("");
    updateMutation.mutate({ userId: user.id, data }, {
      onSuccess: () => {
        setUpdateNotice(`${adminUserLabel(user)} 的${description}已更新。`);
        void queryClient.invalidateQueries({ queryKey: getGetAdminUsersQueryKey() });
      },
      onError: (error) => setUpdateError(errorMessage(error)),
    });
  };

  const changeRole = (user: AdminUser) => {
    const role = user.role === "admin" ? "member" : "admin";
    if (role === "member" && !window.confirm(`要將 ${adminUserLabel(user)} 的權限改為成員嗎？`)) return;
    updateUser(user, { role }, "角色");
  };
  const toggleAccess = (user: AdminUser) => {
    const banned = !user.banned;
    const action = banned ? "停用" : "恢復";
    if (!window.confirm(`確定要${action} ${adminUserLabel(user)} 的帳戶嗎？`)) return;
    updateUser(user, { banned }, "帳戶狀態");
  };
  const deleteUser = (user: AdminUser) => {
    const label = adminUserLabel(user);
    const confirmationValue = user.email || user.id;
    const confirmedValue = window.prompt(
      `永久刪除 ${label} 的 Clerk 帳戶及本網站以此帳戶 ID 儲存的個股 AI 對話、量化研究與紙上交易資料。此操作無法復原。LINE 助理聊天紀錄依 LINE 身分保存，不會連帶刪除。\n\n請輸入 ${confirmationValue} 確認刪除：`,
    );
    if (confirmedValue !== confirmationValue) return;
    setUpdateNotice("");
    setUpdateError("");
    deleteMutation.mutate({ userId: user.id }, {
      onSuccess: () => {
        setUpdateNotice(`${label} 的 Clerk 帳戶及本站帳戶資料已永久刪除。`);
        if (users.length === 1 && offset > 0) {
          setOffset(Math.max(0, offset - PAGE_SIZE));
        }
        void queryClient.invalidateQueries({ queryKey: getGetAdminUsersQueryKey() });
      },
      onError: (error) => setUpdateError(errorMessage(error)),
    });
  };

  return (
    <div className="account-screen">
      <AccountStyles />
      <div className="account-wrap">
        <AccountMasthead />
        <main className="account-main">
          <div className="account-heading">
            <p className="account-eyebrow">ACCESS CONTROL / 01</p>
            <h1>管理研究空間的使用者</h1>
            <p>邀請可信任的研究夥伴，並管理帳戶權限。使用者須透過邀請連結完成帳戶設定後才能進入。永久刪除會移除使用者的 Clerk 帳戶與本站帳戶資料；管理員帳戶及自己的帳戶不可刪除。</p>
          </div>
          <div className="account-admin-grid">
            <section className="account-panel account-users" aria-labelledby="users-title">
              <div className="account-toolbar">
                <div><h2 id="users-title">使用者名冊</h2><p>顯示所有 Clerk 帳號；未獲邀帳號不會取得應用程式存取權</p></div>
                <span className="account-count" data-testid="text-admin-user-count">{usersQuery.isLoading ? "讀取中" : `${total} 位使用者`}</span>
              </div>
              {updateNotice && <div className="account-feedback" role="status" data-testid="status-user-update-success"><Check size={14} />{updateNotice}<button type="button" aria-label="關閉訊息" onClick={() => setUpdateNotice("")} data-testid="button-dismiss-update-success"><X size={13} /></button></div>}
              {updateError && <div className="account-feedback error" role="alert" data-testid="error-user-update"><CircleAlert size={14} />{updateError}<button type="button" aria-label="關閉訊息" onClick={() => setUpdateError("")} data-testid="button-dismiss-update-error"><X size={13} /></button></div>}
              <div className="account-controls">
                <label className="account-search"><Search size={15} /><input type="search" value={searchInput} onChange={(event) => { setSearchInput(event.target.value); setOffset(0); }} placeholder="搜尋姓名或電子郵件" aria-label="搜尋使用者" data-testid="input-user-search" /></label>
              </div>
              {usersQuery.isLoading && !usersQuery.data ? (
                <div className="account-skeleton" aria-label="正在載入使用者" data-testid="status-users-loading"><span /><span /><span /><span /></div>
              ) : usersQuery.isError && !usersQuery.data ? (
                <div className="account-state-card" role="alert" data-testid="error-admin-users"><div><CircleAlert size={22} color="#b84f42" /><strong>名冊暫時無法載入</strong><p>{errorMessage(usersQuery.error)}</p><button type="button" className="account-button account-button-quiet" onClick={() => void usersQuery.refetch()} data-testid="button-retry-admin-users">重新載入</button></div></div>
              ) : users.length === 0 ? (
                <div className="account-state-card" data-testid="status-users-empty"><div><Users size={23} color="#176b66" /><strong>{searchInput.trim() ? "找不到符合條件的使用者" : "目前還沒有使用者"}</strong><p>{searchInput.trim() ? "請嘗試其他姓名或電子郵件。" : "寄送第一封邀請，開始建立你的研究空間。"} </p></div></div>
              ) : (
                <>
                  <div className="account-table-wrap">
                    <table className="account-table" data-testid="table-admin-users">
                      <thead><tr><th>使用者</th><th>角色</th><th>存取</th><th>建立日期</th><th>最近登入</th><th><span className="sr-only">操作</span></th></tr></thead>
                      <tbody>{users.map((user) => <UserRow key={user.id} user={user} busy={updateMutation.isPending || deleteMutation.isPending} currentUserId={currentUserId ?? undefined} onRole={changeRole} onToggle={toggleAccess} onDelete={deleteUser} />)}</tbody>
                    </table>
                  </div>
                  <div className="account-pager">
                    <span data-testid="text-users-pagination">顯示 {pageStart}–{pageEnd}，共 {total} 位</span>
                    <div className="account-pager-controls">
                      <button type="button" className="account-page-button" aria-label="上一頁" disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} data-testid="button-users-previous"><ChevronLeft size={15} /></button>
                      <button type="button" className="account-page-button" aria-label="下一頁" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)} data-testid="button-users-next"><ChevronRight size={15} /></button>
                    </div>
                  </div>
                </>
              )}
            </section>
            <aside className="account-panel account-invite" aria-labelledby="invite-title">
              <div className="account-invite-icon"><UserPlus size={18} /></div>
              <h2 id="invite-title">邀請使用者</h2>
              <p>會請 Clerk 寄送邀請郵件，但本頁無法確認送達。重寄時會建立新邀請，舊連結仍有效；若收件者未收到，可複製連結並私下轉交。</p>
              {inviteNotice && <div className="account-feedback" role="status" data-testid="status-invitation-success"><Check size={14} /><span>{inviteNotice}</span><button type="button" aria-label="關閉訊息" onClick={dismissInviteNotice} data-testid="button-dismiss-invitation-success"><X size={13} /></button></div>}
              {inviteUrl && (
                <div className="account-invitation-link" data-testid="section-invitation-link">
                  <label htmlFor="generated-invitation-url">專屬邀請連結（請勿公開分享）</label>
                  <div className="account-invitation-link-controls">
                    <input
                      id="generated-invitation-url"
                      type="text"
                      readOnly
                      value={inviteUrl}
                      onFocus={(event) => event.currentTarget.select()}
                      aria-label="專屬邀請連結"
                      data-testid="input-invitation-url"
                    />
                    <button type="button" onClick={() => void copyInvitationUrl()} data-testid="button-copy-invitation-url">
                      <Copy size={13} />複製連結
                    </button>
                  </div>
                  <small role="status" aria-live="polite" data-testid="status-invitation-copy">{inviteCopyNotice || "此連結具有邀請權限，只能傳給指定收件者。"}</small>
                </div>
              )}
              {inviteError && <div className="account-feedback error" role="alert" data-testid="error-invitation"><CircleAlert size={14} />{inviteError}<button type="button" aria-label="關閉訊息" onClick={() => setInviteError("")} data-testid="button-dismiss-invitation-error"><X size={13} /></button></div>}
              <Form {...inviteForm}>
                <form className="account-form" onSubmit={inviteForm.handleSubmit(invite)} noValidate data-testid="form-invite-user">
                  <FormField
                    control={inviteForm.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem className="account-form-field">
                        <FormLabel>電子郵件地址</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="email"
                            maxLength={254}
                            autoComplete="email"
                            placeholder="name@example.com"
                            data-testid="input-invite-email"
                          />
                        </FormControl>
                        <FormMessage className="account-form-error" />
                      </FormItem>
                    )}
                  />
                <button type="submit" className="account-button account-button-primary" disabled={inviteMutation.isPending || !email.trim()} data-testid="button-send-invitation">
                  {inviteMutation.isPending ? "正在寄送邀請…" : <>寄送邀請 <ArrowUpRight size={14} /></>}
                </button>
                </form>
              </Form>
              <p className="account-note">邀請不會授予管理員權限。角色可在使用者名冊中調整。</p>
            </aside>
          </div>
          <section className="account-panel account-diagnostic" aria-labelledby="web-search-diagnostic-title" data-testid="section-web-search-diagnostic">
            <div className="account-diagnostic-head">
              <div>
                <h2 id="web-search-diagnostic-title">網頁搜尋連線檢查</h2>
                <p>以固定測試詞檢查正式 API 的連線與結果解析；不呼叫 AI，也不回傳或保存搜尋內容。</p>
              </div>
              <button
                type="button"
                className="account-button account-button-quiet"
                onClick={() => diagnosticMutation.mutate(undefined)}
                disabled={diagnosticMutation.isPending}
                data-testid="button-run-web-search-diagnostic"
              >
                {diagnosticMutation.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <Search size={14} />}
                {diagnosticMutation.isPending ? "檢查中…" : "執行檢查"}
              </button>
            </div>
            {diagnosticMutation.error && (
              <div className="account-feedback error" role="alert" data-testid="error-web-search-diagnostic">
                <CircleAlert size={14} />{errorMessage(diagnosticMutation.error)}
              </div>
            )}
            {diagnosticResult && (
              <div
                className={`account-diagnostic-result${diagnosticResult.outcome === "failed" ? " error" : ""}`}
                role="status"
                data-testid="status-web-search-diagnostic"
              >
                <span><strong>{diagnosticOutcomeLabel}</strong></span>
                <span>來源：<strong>{diagnosticProviderLabel}</strong></span>
                <span>HTTP：<strong>{diagnosticResult.httpStatus ?? "無回應"}</strong></span>
                <span>解析結果：<strong>{diagnosticResult.resultCount}</strong></span>
                {diagnosticResult.failureKind && <span>錯誤類型：<strong>{diagnosticResult.failureKind}</strong></span>}
                <span>檢查時間：<strong>{new Date(diagnosticResult.checkedAt).toLocaleString("zh-TW")}</strong></span>
              </div>
            )}
          </section>
          <p className="route-footnote" data-testid="text-account-admin-note">行情與研究內容不會顯示於帳戶管理頁面；此處僅用於維護研究空間的登入權限。</p>
        </main>
      </div>
    </div>
  );
}

function AuthIntro({ invitation = false }: { invitation?: boolean }) {
  return (
    <div className="account-auth-copy">
      <div className="account-heading">
        <p className="account-eyebrow">{invitation ? "INVITED ACCESS / 02" : "MEMBER ACCESS / 01"}</p>
        <h1>{invitation ? "完成你的研究空間帳戶設定" : "回到你的台股研究桌"}</h1>
        <p>{invitation ? "透過管理員寄給你的專屬邀請連結設定帳戶。你的研究與自選資料將依登入狀態安全存取。" : "此研究空間採邀請制。登入後查看官方行情、AI 研究脈絡，以及你的私人自選清單。"}</p>
      </div>
      <div className="account-auth-spec" aria-label="研究空間說明">
        <div><span>市場範圍</span><strong>TAIWAN / TWSE · TPEx</strong></div>
        <div><span>行情參考</span><strong>官方來源標示</strong></div>
        <div><span>存取方式</span><strong>CLERK SESSION</strong></div>
      </div>
      <Link href="/" className="account-back" data-testid="link-account-dashboard"><ArrowLeft size={14} /> 返回市場分析</Link>
    </div>
  );
}

export function SignInPage() {
  const returnToAdminUsers =
    new URLSearchParams(window.location.search).get("returnTo") === "admin-users";

  return (
    <div className="account-screen">
      <AccountStyles />
      <div className="account-wrap">
        <AccountMasthead />
        <main className="account-auth-layout">
          <AuthIntro />
          <section className="account-clerk-panel" aria-label="登入表單" data-testid="panel-sign-in">
            <SignIn
              routing="path"
              path={appRoute("/sign-in")}
              signUpUrl={appRoute("/accept-invitation")}
              forceRedirectUrl={returnToAdminUsers ? appRoute("/admin/users") : undefined}
              fallbackRedirectUrl={appRoute("/")}
            />
          </section>
        </main>
      </div>
    </div>
  );
}

function hasInvitationTicket() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return Boolean(params.get("__clerk_ticket") || params.get("ticket"));
}

export function AcceptInvitationPage() {
  const ticketAvailable = hasInvitationTicket();
  return (
    <div className="account-screen">
      <AccountStyles />
      <div className="account-wrap">
        <AccountMasthead />
        <main className="account-auth-layout">
          <AuthIntro invitation />
          {ticketAvailable ? (
            <section className="account-clerk-panel" aria-label="完成帳戶設定" data-testid="panel-accept-invitation">
              <SignUp
                routing="path"
                path={appRoute("/accept-invitation")}
                fallbackRedirectUrl={appRoute("/")}
              />
            </section>
          ) : (
            <section className="account-ticket-notice" data-testid="status-invitation-ticket-required">
              <KeyRound size={21} />
              <strong>需要管理員邀請連結</strong>
              <p>帳戶設定只能從管理員寄送的邀請信開始。請使用信件中的完整連結；若你已經有帳戶，可以直接登入研究空間。</p>
              <Link href="/sign-in" className="account-back" data-testid="link-invitation-to-sign-in"><ArrowLeft size={14} /> 前往登入</Link>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}