export type Theme = "dark" | "light";
export type ThemePreference = Theme | "system";
export const CHAPTER_PAGE_SIZE = 100;

export function resolveThemePreference(storedTheme: string | null): ThemePreference {
  return storedTheme === "dark" || storedTheme === "light" ? storedTheme : "system";
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): Theme {
  if (preference === "dark" || preference === "light") return preference;
  return prefersDark ? "dark" : "light";
}

export function chapterPagePath(bookId: string, offset: number) {
  return `/api/books/${encodeURIComponent(bookId)}/chapters?limit=${CHAPTER_PAGE_SIZE}&offset=${offset}`;
}

export async function responseJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json() as { message?: unknown }
    : undefined;

  if (!response.ok) {
    const message = typeof body?.message === "string" && body.message.trim()
      ? body.message
      : `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }

  if (body === undefined) throw new Error("服务端未返回 JSON 数据");
  return body as T;
}
