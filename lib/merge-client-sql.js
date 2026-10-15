/**
 * The survivor-side SQL for one array column when scripts/prod/merge-client.mjs
 * folds a duplicate client into a survivor: order-preserving append of the
 * duplicate's ids the survivor lacks, keeping only ids that still exist in
 * `validates`.
 *
 * NULL-SAFE, because `clients.package_ids` is nullable (null = never chosen, {} =
 * chosen none): two nulls stay null, and a null side counts as empty in the union,
 * so `e = any(NULL)` cannot drop every id and `NULL || array` cannot lose the ids
 * the duplicate brings.
 */
export function arrayUnionAssignment(column, validates) {
  return `${column} = case when s.${column} is null and d.${column} is null then null
          else coalesce(s.${column}, '{}') || array(
            select e from unnest(coalesce(d.${column}, '{}')) e
             where not (e = any(coalesce(s.${column}, '{}')))
               and exists (select 1 from ${validates} p where p.id = e)
          ) end`
}
