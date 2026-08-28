import { revalidateTag, unstable_cache } from "next/cache";
import { query } from "@/lib/db";
import type { DocVersion } from "@/lib/docs/store";

const REVALIDATE_SECONDS = 30;

function versionTag(slug: string): string {
  return `doc-version:${slug}`;
}

export function findVersionBySlug(slug: string): Promise<DocVersion | null> {
  const tag = versionTag(slug);
  return unstable_cache(
    async () => {
      const { rows } = await query<DocVersion>(
        `SELECT id, owner_id, is_public, view_token, version
         FROM documents WHERE slug = $1 AND deleted_at IS NULL`,
        [slug]
      );
      return rows[0] ?? null;
    },
    [tag],
    { revalidate: REVALIDATE_SECONDS, tags: [tag] }
  )();
}

export function invalidateDocVersion(slug: string): void {
  try {
    revalidateTag(versionTag(slug));
  } catch {
    return;
  }
}
