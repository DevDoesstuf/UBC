"use client";
// The account chip in the phone header. Today it shows the player's initials. The sign-in button
// (<WalletButton/> from components/wallet) mounts here when it is wired in: pass it as `children`
// and the initials chip steps aside. Keep this slot 44 px tall so the header never jumps.
import type { ReactNode } from "react";
import { Avatar } from "./ui";

export function AccountSlot({ name, children }: { name: string; children?: ReactNode }) {
  return (
    <div className="acct-slot" data-slot="account" title={name}>
      {children ?? <Avatar name={name} size={32} />}
    </div>
  );
}
