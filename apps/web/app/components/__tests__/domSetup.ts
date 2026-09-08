import { configure } from "@testing-library/react";

// `waitFor` / `findBy*` default to 1 s. Under the full parallel run a
// component that chains two or three server-function round trips through
// transitions can take longer than that on a loaded machine, which turned
// otherwise-correct tests red (PH-03 F-1, PH-04). 5 s is a ceiling, not a
// wait: a passing assertion still returns as soon as it holds.
configure({ asyncUtilTimeout: 5_000 });
