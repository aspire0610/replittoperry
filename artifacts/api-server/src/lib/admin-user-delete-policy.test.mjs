import assert from "node:assert/strict";
import test from "node:test";
import { getAdminUserDeleteBlockReason } from "./admin-user-delete-policy.ts";

const base = {
  actorId: "admin-user",
  targetId: "member-user",
  targetIsBootstrapAdmin: false,
  targetRole: "member",
};

test("allows an administrator to delete another member account", () => {
  assert.equal(getAdminUserDeleteBlockReason(base), null);
});

test("prevents an administrator from deleting their own account", () => {
  assert.match(
    getAdminUserDeleteBlockReason({ ...base, targetId: base.actorId }),
    /自己的帳戶/,
  );
});

test("protects bootstrap and other administrator accounts", () => {
  assert.match(
    getAdminUserDeleteBlockReason({ ...base, targetIsBootstrapAdmin: true }),
    /管理員帳戶/,
  );
  assert.match(
    getAdminUserDeleteBlockReason({ ...base, targetRole: "admin" }),
    /管理員帳戶/,
  );
});
