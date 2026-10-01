// Line icons in the text colour, for places where an emoji would bring its own colours.
import type { ComponentChildren } from 'preact'

function Svg({ children, title }: { children: ComponentChildren; title?: string }) {
  return (
    <svg class="ui-icon" viewBox="0 0 24 24" aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      {children}
    </svg>
  )
}

export const SaveIcon = () => (
  <Svg>
    <path d="M5 3.5h11l3.5 3.5v13.5h-14.5z" />
    <path d="M8 3.5v5h7.5v-5M8 20.5v-6.5h8.5v6.5" />
  </Svg>
)

export const GlobeIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="8.5" />
    <ellipse cx="12" cy="12" rx="3.8" ry="8.5" />
    <path d="M3.5 12h17M5 7.5h14M5 16.5h14" />
  </Svg>
)

export const PinIcon = () => (
  <Svg>
    <path d="M12 21s-6.5-5.8-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 15.2 12 21 12 21z" />
    <circle cx="12" cy="9.8" r="2.4" />
  </Svg>
)

/** a wheel rolled along a winding line: measuring a path */
export const PathMeasureIcon = () => (
  <Svg>
    <path d="M3 19c3.5 0 3.5-6 7-6s3 4 6 4 2.5-5 5-5" stroke-dasharray="2.2 2.2" />
    <circle cx="16" cy="7.5" r="3.5" />
    <path d="M16 7.5l2-2" />
  </Svg>
)

/** crossed swords */
export const RegimentIcon = () => (
  <Svg>
    <path d="M4 4l10.5 10.5M20 4L9.5 14.5" />
    <path d="M12.5 16.5l4-4M7.5 12.5l4 4" />
    <path d="M15.5 15.5l4 4M8.5 15.5l-4 4" />
  </Svg>
)

/** two people: a people and its ways */
export const CultureIcon = () => (
  <Svg>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20c0-3.6 2.7-6.2 6-6.2s6 2.6 6 6.2" />
    <circle cx="17" cy="9" r="2.6" />
    <path d="M16.2 14.1c2.9.2 4.8 2.6 4.8 5.9" />
  </Svg>
)

/** two arrows in opposite directions: relations between states */
export const DiplomacyIcon = () => (
  <Svg>
    <path d="M4 8.5h15M15.5 5l3.5 3.5-3.5 3.5" />
    <path d="M20 15.5H5M8.5 12L5 15.5 8.5 19" />
  </Svg>
)

export const RulerIcon = () => (
  <Svg>
    <path d="M3.5 15.5l12-12 5 5-12 12z" />
    <path d="M7 12l2 2M9.5 9.5l1.5 1.5M12 7l2 2M14.5 4.5L16 6" />
  </Svg>
)

export const CloudIcon = () => (
  <Svg>
    <path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.4 9.6 4.5 4.5 0 0 0 7 18.5z" />
  </Svg>
)
