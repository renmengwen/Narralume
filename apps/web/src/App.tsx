import { useEffect, useRef, useState } from "react";

import {
  chapterPagePath,
  resolveTheme,
  resolveThemePreference,
  responseJson,
  seriesWorkspaceFromSearch,
  seriesWorkspacePath,
  type ThemePreference,
} from "./client-logic";

interface Book {
  id: string;
  title: string;
  author: string | null;
  encoding: string;
  import_status: string;
  chapter_count: number;
}

interface Chapter {
  id: string;
  title: string;
  chapter_index: number;
  char_count: number;
}

interface SeriesProject {
  id: string;
  bookId: string;
  title: string;
}

export function App() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    resolveThemePreference(localStorage.getItem("narralume-theme")),
  );
  const [books, setBooks] = useState<Book[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [chapterTotal, setChapterTotal] = useState(0);
  const [selectedBook, setSelectedBook] = useState<string>();
  const [activeSeries, setActiveSeries] = useState<SeriesProject>();
  const [chapterText, setChapterText] = useState("");
  const [status, setStatus] = useState("正在加载书库…");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function loadBooks(announce = true) {
    const body = await responseJson<{ items: Book[] }>(await fetch("/api/books"));
    setBooks(body.items);
    if (announce) setStatus(body.items.length ? `已加载 ${body.items.length} 本书` : "书库为空，请导入 TXT");
    return body.items;
  }

  useEffect(() => {
    async function initialize() {
      const loadedBooks = await loadBooks(false);
      const location = seriesWorkspaceFromSearch(window.location.search);
      if (!location) {
        setStatus(loadedBooks.length ? `已加载 ${loadedBooks.length} 本书` : "书库为空，请导入 TXT");
        return;
      }
      if (!loadedBooks.some((book) => book.id === location.bookId)) throw new Error("工作台关联书籍不存在");
      const body = await responseJson<{ items: SeriesProject[] }>(
        await fetch(`/api/books/${encodeURIComponent(location.bookId)}/series`),
      );
      const series = body.items.find((item) => item.id === location.seriesId);
      if (!series) throw new Error("系列项目不存在");
      setActiveSeries(series);
      setStatus(`已恢复系列项目：${series.title}`);
    }
    initialize().catch((error: Error) => setStatus(`加载失败：${error.message}`));
  }, []);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = resolveTheme(themePreference, media.matches);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };

    if (themePreference === "system") localStorage.removeItem("narralume-theme");
    else localStorage.setItem("narralume-theme", themePreference);
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themePreference]);

  async function importFile(file: File) {
    if (busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setStatus("正在导入并索引 TXT，请稍候…");
    try {
      const body = await responseJson<{ message: string; chapter_count: number }>(
        await fetch("/api/books/import", {
          method: "POST",
          headers: { "Content-Type": file.type || "text/plain", "X-File-Name": encodeURIComponent(file.name) },
          body: file,
          signal: controller.signal,
        }),
      );
      abortRef.current = null;
      const successMessage = `${body.message}，共 ${body.chapter_count} 章`;
      try {
        await loadBooks(false);
        setStatus(successMessage);
      } catch (error) {
        setStatus(`${successMessage}；书库刷新失败：${(error as Error).message}`);
      }
    } catch (error) {
      setStatus(error instanceof DOMException && error.name === "AbortError" ? "导入已中断" : `导入失败：${(error as Error).message}`);
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  async function openBook(bookId: string) {
    if (busy) return;
    setBusy(true);
    setSelectedBook(bookId);
    setChapterText("");
    setChapters([]);
    setChapterTotal(0);
    setStatus("正在加载章节…");
    try {
      const body = await responseJson<{ items: Chapter[]; total: number }>(await fetch(chapterPagePath(bookId, 0)));
      setChapters(body.items);
      setChapterTotal(body.total);
      setStatus(`已加载 ${body.items.length}/${body.total} 章`);
    } catch (error) {
      setStatus(`章节加载失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadMoreChapters() {
    if (!selectedBook || busy || chapters.length >= chapterTotal) return;
    setBusy(true);
    setStatus(`正在加载更多章节（${chapters.length}/${chapterTotal}）…`);
    try {
      const body = await responseJson<{ items: Chapter[]; total: number }>(
        await fetch(chapterPagePath(selectedBook, chapters.length)),
      );
      setChapters((current) => [...current, ...body.items]);
      setChapterTotal(body.total);
      setStatus(`已加载 ${chapters.length + body.items.length}/${body.total} 章`);
    } catch (error) {
      setStatus(`更多章节加载失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function openChapter(chapterId: string) {
    if (!selectedBook || busy) return;
    setBusy(true);
    setStatus("正在读取原文…");
    try {
      const body = await responseJson<{ text: string }>(await fetch(`/api/books/${selectedBook}/chapters/${chapterId}/text`));
      setChapterText(body.text);
      setStatus("原文已加载");
    } catch (error) {
      setStatus(`原文读取失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function enterSeriesWorkspace() {
    if (!selectedBook || busy) return;
    const book = books.find((item) => item.id === selectedBook);
    if (!book) return;
    setBusy(true);
    setStatus("正在准备系列项目…");
    try {
      const existing = await responseJson<{ items: SeriesProject[] }>(
        await fetch(`/api/books/${encodeURIComponent(book.id)}/series`),
      );
      const series = existing.items[0] ?? (await responseJson<{ series: SeriesProject }>(
        await fetch(`/api/books/${encodeURIComponent(book.id)}/series`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: `${book.title}视觉说书` }),
        }),
      )).series;
      setActiveSeries(series);
      window.history.pushState(null, "", seriesWorkspacePath(book.id, series.id));
      setStatus(existing.items.length ? `已进入系列项目：${series.title}` : `系列项目已创建：${series.title}`);
    } catch (error) {
      setStatus(`进入下一步失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function leaveSeriesWorkspace() {
    setActiveSeries(undefined);
    window.history.pushState(null, "", window.location.pathname);
    setStatus("已返回书库");
  }

  if (activeSeries) return (
    <main className="workspace-shell">
      <div className="workspace-frame">
        <header className="topbar">
          <div className="brand-block">
            <p className="eyebrow">NARRALUME / 叙影</p>
            <div className="title-row">
              <h1>{activeSeries.title}</h1>
              <span className="phase-tag">SERIES</span>
            </div>
            <p className="subtitle">从章节证据开始，依次完成改编、资产、音频、视觉和成片。</p>
          </div>
          <div className="toolbar">
            <button className="button-secondary" type="button" onClick={leaveSeriesWorkspace}>返回书库</button>
          </div>
        </header>
        <div className="status-strip" role="status" aria-live="polite">
          <span className={busy ? "status-dot is-active" : "status-dot"} aria-hidden="true" />
          <span>{status}</span>
        </div>
        <section className="series-workspace" aria-labelledby="workflow-heading">
          <div className="series-intro">
            <p className="eyebrow">当前下一步</p>
            <h2 id="workflow-heading">选择章节并生成结构化事件</h2>
            <p>系列项目已就绪。后续工作区将在这里接通章节事件、故事弧、稿件审核、资产、音频、视觉与渲染。</p>
          </div>
          <ol className="stage-list" aria-label="系列生产阶段">
            {["章节事件", "故事弧与分集", "忠实稿与包装稿", "资产与候选图", "TTS 与字幕", "视觉段与渲染", "审核与导出"].map((stage, index) => (
              <li key={stage} className={index === 0 ? "is-current" : ""}>
                <span>{String(index + 1).padStart(2, "0")}</span>{stage}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );

  return (
    <main className="workspace-shell">
      <div className="workspace-frame">
        <header className="topbar">
          <div className="brand-block">
            <p className="eyebrow">NARRALUME / 叙影</p>
            <div className="title-row">
              <h1>长篇故事书库</h1>
              <span className="phase-tag">PHASE 01</span>
            </div>
            <p className="subtitle">导入真实 TXT，核对编码、章节和原文证据。</p>
          </div>
          <div className="toolbar">
            <div className="theme-control" role="group" aria-label="页面主题">
              {(["system", "light", "dark"] as const).map((preference) => (
                <button
                  className="theme-option"
                  type="button"
                  key={preference}
                  aria-pressed={themePreference === preference}
                  onClick={() => setThemePreference(preference)}
                >
                  {preference === "system" ? "系统" : preference === "light" ? "浅色" : "深色"}
                </button>
              ))}
            </div>
            <label className={`button-primary ${busy ? "is-disabled" : ""}`}>
              {busy ? "正在处理…" : "导入 TXT"}
              <input
                className="sr-only"
                type="file"
                accept=".txt,text/plain"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importFile(file);
                  event.target.value = "";
                }}
              />
            </label>
            <button
              className="button-primary"
              type="button"
              disabled={!selectedBook || busy}
              onClick={() => void enterSeriesWorkspace()}
            >
              {busy && selectedBook ? "正在准备…" : "下一步：系列工作台"}
            </button>
            {busy && abortRef.current ? (
              <button className="button-secondary" type="button" onClick={() => abortRef.current?.abort()}>
                中断导入
              </button>
            ) : null}
          </div>
        </header>

        <div className="status-strip" role="status" aria-live="polite">
          <span className={busy ? "status-dot is-active" : "status-dot"} aria-hidden="true" />
          <span>{status}</span>
        </div>

        <div className="workspace-grid">
          <section className="panel" aria-labelledby="books-heading">
            <div className="panel-heading">
              <h2 id="books-heading">书籍</h2>
              <span>{books.length}</span>
            </div>
            <div className="panel-list">
              {books.map((book) => (
                <button
                  key={book.id}
                  disabled={busy}
                  onClick={() => void openBook(book.id)}
                  className={`list-item ${selectedBook === book.id ? "is-selected" : ""}`}
                >
                  <span className="item-title" title={book.title}>{book.title}</span>
                  <span className="item-meta">{book.encoding} / {book.chapter_count} 章</span>
                </button>
              ))}
              {!books.length ? <p className="empty-state">尚未导入书籍</p> : null}
            </div>
          </section>

          <section className="panel" aria-labelledby="chapters-heading">
            <div className="panel-heading">
              <h2 id="chapters-heading">章节索引</h2>
              <span>{chapters.length}</span>
            </div>
            <div className="panel-list scroll-region">
              {chapters.map((chapter) => (
                <button key={chapter.id} disabled={busy} onClick={() => void openChapter(chapter.id)} className="list-item chapter-item">
                  <span className="chapter-index">{String(chapter.chapter_index + 1).padStart(3, "0")}</span>
                  <span className="item-title" title={chapter.title}>{chapter.title}</span>
                </button>
              ))}
              {chapters.length < chapterTotal ? (
                <button className="load-more" type="button" disabled={busy} onClick={() => void loadMoreChapters()}>
                  加载更多（{chapters.length}/{chapterTotal}）
                </button>
              ) : null}
              {!chapters.length ? <p className="empty-state">选择书籍后查看章节</p> : null}
            </div>
          </section>

          <section className="panel evidence-panel" aria-labelledby="evidence-heading">
            <div className="panel-heading">
              <h2 id="evidence-heading">原文证据</h2>
              <span>READ ONLY</span>
            </div>
            <pre className="evidence-text">
              {chapterText || "选择章节后在此查看原文。"}
            </pre>
          </section>
        </div>
      </div>
    </main>
  );
}
