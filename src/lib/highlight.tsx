/**
 * Wraps matched substrings in <mark class="list-search-hit">.
 * Returns a React node array safe for JSX rendering.
 * Pass the primary display string and the current search query.
 */
export function highlightMatch(text: string, query: string): React.ReactNode {
  const trimmed = query.trim()
  if (!trimmed) return text

  const lowerText = text.toLowerCase()
  const lowerQuery = trimmed.toLowerCase()
  const index = lowerText.indexOf(lowerQuery)
  if (index === -1) return text

  return (
    <>
      {text.slice(0, index)}
      <mark className="list-search-hit">{text.slice(index, index + trimmed.length)}</mark>
      {text.slice(index + trimmed.length)}
    </>
  )
}
