/**
 * The brand lockup: the Dot & Mist icon plus the "fog" wordmark
 * (Avenir Next Regular, outlined into paths — the design tokens forbid web
 * fonts, so vectorizing is what keeps the wordmark identical off-macOS).
 *
 * The accent colour appears only as the 「点」 (the 「色は役割」 rule in
 * `spec/design/index.md`), and in the signed-in shell it lives inside this
 * icon. Master SVGs live in `spec/design/icons/`.
 */
export function Brand() {
  return (
    <span className="flex items-center text-neutral-900">
      <svg
        viewBox="0 0 120 44"
        width="65.5"
        height="24"
        role="img"
        aria-label="fog"
      >
        <g transform="scale(1.75)">
          <path
            d="M4.5 12 H19.5 M7 16 H15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <circle cx="16.5" cy="7" r="1.8" fill="var(--color-accent)" />
        </g>
        <g
          transform="translate(60 33.68) scale(0.04 -0.04)"
          fill="currentColor"
        >
          <path d="M288 411L178 411L178 0L110 0L110 411L12 411L12 468L110 468L110 596Q110 676 149 722Q188 768 269 768Q282 768 297 766.5Q312 765 325 761L313 701Q302 704 291 706Q280 708 266 708Q239 708 221.5 699Q204 690 194.5 673.5Q185 657 181.5 635Q178 613 178 588L178 468L288 468Z" />
          <path
            transform="translate(273 0)"
            d="M555 234Q555 181 536.5 136Q518 91 485 58Q452 25 406 6.5Q360 -12 305 -12Q251 -12 205 6.5Q159 25 126 58Q93 91 74.5 136Q56 181 56 234Q56 287 74.5 332Q93 377 126 410Q159 443 205 461.5Q251 480 305 480Q360 480 406 461.5Q452 443 485 410Q518 377 536.5 332Q555 287 555 234ZM483 234Q483 273 470.5 307.5Q458 342 435 367.5Q412 393 379 408Q346 423 305 423Q264 423 231.5 408Q199 393 176 367.5Q153 342 140.5 307.5Q128 273 128 234Q128 195 140.5 160.5Q153 126 176 100.5Q199 75 231.5 60.5Q264 46 305 46Q346 46 379 60.5Q412 75 435 100.5Q458 126 470.5 160.5Q483 195 483 234Z"
          />
          <path
            transform="translate(862 0)"
            d="M115 -94Q143 -130 191.5 -155Q240 -180 294 -180Q344 -180 379 -165.5Q414 -151 435.5 -126Q457 -101 467 -67.5Q477 -34 477 4L477 92L475 92Q448 48 398.5 24Q349 0 298 0Q243 0 198.5 18Q154 36 122.5 67.5Q91 99 73.5 143Q56 187 56 238Q56 288 73.5 332Q91 376 122.5 409Q154 442 198.5 461Q243 480 298 480Q349 480 398 456Q447 432 475 387L477 387L477 468L545 468L545 4Q545 -34 534.5 -77Q524 -120 495.5 -156Q467 -192 418 -216Q369 -240 291 -240Q226 -240 167 -215Q108 -190 66 -146ZM128 240Q128 203 140 170Q152 137 174.5 112Q197 87 230 72.5Q263 58 305 58Q344 58 377 71Q410 84 434 108Q458 132 471.5 165.5Q485 199 485 240Q485 277 471.5 310Q458 343 434 368Q410 393 377 408Q344 423 305 423Q263 423 230 408Q197 393 174.5 368Q152 343 140 310Q128 277 128 240Z"
          />
        </g>
      </svg>
    </span>
  );
}
