import { BrandMark } from './BrandMark'
import { cn } from '@/utils/cn'

// The GrubChat logotype: the chat-bubble brandmark (dark bubble + orange disc +
// fork) followed by "Grub" (theme text / white on dark) + "Chat" (orange accent).
// The orange "Chat" split is the sanctioned brand accent — it is a logotype, not
// a CTA, so it does not break the "orange = accent only" rule. Logotype sizes are
// intentionally OUT of the --text-* type scale.

export type WordmarkSize = 'sm' | 'md' | 'lg'

export interface WordmarkProps {
  /** Mark + type scale. sm = app sidebar header, md = landing nav, lg = hero/splash. */
  size?: WordmarkSize
  /** On dark surfaces (auth panel, dark landing sections), render "Grub" + the
   * bubble/fork white. */
  dark?: boolean
  /** Render the chat-bubble brandmark. Off in the app sidebar, where the rail badge is the mark. */
  showTile?: boolean
  className?: string
}

const SIZES: Record<WordmarkSize, { mark: number; text: string }> = {
  sm: { mark: 26, text: 'text-[17px]' },
  md: { mark: 30, text: 'text-[22px]' }, // === legacy Landing wordmark
  lg: { mark: 34, text: 'text-[26px]' },
}

export function Wordmark({ size = 'md', dark = false, showTile = true, className }: WordmarkProps) {
  const s = SIZES[size]
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      {showTile && <BrandMark size={s.mark} className={dark ? 'text-white' : 'text-text'} />}
      <span className={cn('font-display font-extrabold leading-none', s.text)}>
        <span className={dark ? 'text-white' : 'text-text'}>Grub</span>
        <span className="text-primary">Chat</span>
      </span>
    </div>
  )
}
