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
 * A text link beside or inside a form (`.form-link` in
 * `spec/design/pages/login.html` and `settings.html`): the entries under the
 * auth sheet's form (アカウント登録, パスワードを忘れた), the one link inside a
 * form error that resolves it (ログイン, パスワードリセット), and the way to a
 * reset beside the password change. It takes the size of the sentence or the
 * row it sits in, which is what the owner of that line sets.
 */
export const FormLink = createLink(FormAnchor);
