"use client";

import { createLink } from "@tanstack/react-router";
import type { ComponentPropsWithRef } from "react";

type FormAnchorProps = Omit<ComponentPropsWithRef<"a">, "className" | "style">;

// The router merges `className` / `style` into what it hands the anchor; both
// are written after the spread so that nothing but this look reaches it.
function FormAnchor(props: FormAnchorProps) {
  return (
    <a
      {...props}
      className="rounded-sm text-primary-dark no-underline transition-colors hover:text-primary-darker focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      style={undefined}
    />
  );
}

/**
 * A text link on the auth sheet (`.form-link` in
 * `spec/design/pages/login.html`): the entries under the form (アカウント登録,
 * パスワードを忘れた) and the one link inside a form error that resolves it
 * (ログイン, パスワードリセット). It takes the size of the sentence it sits in.
 */
export const FormLink = createLink(FormAnchor);
