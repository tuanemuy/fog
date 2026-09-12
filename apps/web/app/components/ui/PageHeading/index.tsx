"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * Who draws the page's `h1` in the frame around a screen: the app shell's
 * header always draws one (`"frame"`), the auth sheet leaves it to the
 * screen (`"screen"`, `AuthSheetTitle`). A route error or 404 drawn in
 * place of the screen reads it to know whether its sentence has to be that
 * heading. With no frame around it, the answer is `"frame"`.
 */
export type PageHeadingOwner = "frame" | "screen";

const Owner = createContext<PageHeadingOwner>("frame");

export function PageHeadingOwnerProvider({
  owner,
  children,
}: Readonly<{ owner: PageHeadingOwner; children: ReactNode }>) {
  return <Owner.Provider value={owner}>{children}</Owner.Provider>;
}

export function usePageHeadingOwner(): PageHeadingOwner {
  return useContext(Owner);
}
