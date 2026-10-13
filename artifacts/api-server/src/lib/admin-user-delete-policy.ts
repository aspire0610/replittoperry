export function getAdminUserDeleteBlockReason({
  actorId,
  targetId,
  targetIsBootstrapAdmin,
  targetRole,
}: {
  actorId: string;
  targetId: string;
  targetIsBootstrapAdmin: boolean;
  targetRole: unknown;
}): string | null {
  if (actorId === targetId) {
    return "不可刪除自己的帳戶。";
  }
  if (targetIsBootstrapAdmin || targetRole === "admin") {
    return "不可刪除管理員帳戶；請先將其他管理員改為成員。";
  }
  return null;
}
