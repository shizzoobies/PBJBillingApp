import { Search, X } from 'lucide-react'
import { useRef } from 'react'

export interface ListSearchProps {
  value: string
  onChange: (v: string) => void
  placeholder: string
  resultCount?: number
  total?: number
  className?: string
}

/**
 * Reusable premium search box for long list pages.
 * - Leading Search icon, trailing clear (X) button when there is text.
 * - Shows "N of M" result count when resultCount + total are provided and query is non-empty.
 * - Pressing Escape clears the query.
 * - role="searchbox" + aria-label for accessibility.
 */
export function ListSearch({
  value,
  onChange,
  placeholder,
  resultCount,
  total,
  className,
}: ListSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      onChange('')
    }
  }

  // Keep focus stable when the clear button removes the query — re-focus input.
  const handleClear = () => {
    onChange('')
    inputRef.current?.focus()
  }

  const showCount =
    value.trim().length > 0 && resultCount !== undefined && total !== undefined

  return (
    <div className={`list-search${className ? ` ${className}` : ''}`}>
      <div className="list-search-field">
        <Search className="list-search-icon" size={15} aria-hidden="true" />
        <input
          ref={inputRef}
          className="list-search-input"
          role="searchbox"
          aria-label={placeholder}
          type="search"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        {value.length > 0 ? (
          <button
            className="list-search-clear"
            type="button"
            aria-label="Clear search"
            onClick={handleClear}
          >
            <X size={13} />
          </button>
        ) : (
          /* Reserve the same space so layout never shifts */
          <span className="list-search-clear-placeholder" aria-hidden="true" />
        )}
      </div>
      {showCount ? (
        <span className="list-search-count" aria-live="polite" aria-atomic="true">
          {resultCount} of {total}
        </span>
      ) : null}
    </div>
  )
}

