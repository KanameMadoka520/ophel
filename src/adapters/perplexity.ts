/**
 * Perplexity 适配器（www.perplexity.ai）
 *
 * 设计目标：
 * - 优先依赖相对稳定的 id / data-testid / 路由结构
 * - 输入框与消息区域使用多重选择器兜底，兼容首页与线程页
 * - 会话列表优先从侧边栏 DOM 读取，必要时用线程 API 预拉取做缓存
 */
import { SITE_IDS } from "~constants"
import { DOMToolkit } from "~utils/dom-toolkit"
import { htmlToMarkdown } from "~utils/exporter"

import {
  SiteAdapter,
  type ConversationInfo,
  type ConversationObserverConfig,
  type ExportConfig,
  type NetworkMonitorConfig,
  type OutlineItem,
} from "./base"

const HOSTNAMES = new Set(["www.perplexity.ai", "perplexity.ai"])
const THREAD_PATH_PATTERN = /^\/(?:search|page)\/([^/?#]+)(?:\/|$)/i
const NEW_THREAD_PATH_PATTERN = /^\/search\/new(?:\/|$)/i

const TEXTAREA_SELECTORS = [
  "#ask-input",
  'div[contenteditable="true"][role="textbox"]:not([id])',
  'div[contenteditable="true"][g_editable="true"]',
  'div[contenteditable="true"][data-lexical-editor="true"]',
  'div[contenteditable="true"][role="textbox"]',
]

const SUBMIT_BUTTON_SELECTOR = 'button[data-testid="submit-button"], button[type="submit"]'
const STOP_BUTTON_SELECTOR =
  'button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="stop"]'
const NEW_CHAT_BUTTON_SELECTORS = [
  'a[href="/"]',
  'a[href="/search/new"]',
  'button[data-testid="new-thread-button"]',
]

const USER_QUERY_SELECTOR = [
  ".group\\/query",
  "[role='tabpanel'] .group.relative.flex.items-end.mb-xs",
].join(", ")

const USER_QUERY_CONTENT_SELECTOR = [
  ".group\\/query .whitespace-pre-wrap",
  ".group\\/query [dir='auto']",
  ".group\\/query p",
  ".group\\/query [data-lexical-text='true']",
  "[role='tabpanel'] .group.relative.flex.items-end.mb-xs .whitespace-pre-wrap",
  "[role='tabpanel'] .group.relative.flex.items-end.mb-xs [dir='auto']",
  "[role='tabpanel'] .group.relative.flex.items-end.mb-xs p",
  "[role='tabpanel'] .group.relative.flex.items-end.mb-xs [data-lexical-text='true']",
].join(", ")

const ASSISTANT_MESSAGE_SELECTOR = [
  "div[id*='markdown-content-']",
  "div[id*='Markdown-Content-']",
].join(", ")

const RESPONSE_CONTAINER_SELECTOR = [
  "[role='tabpanel']",
  "main [class*='overflow-y-auto']",
  "main [class*='overflow-auto']",
  "main",
].join(", ")

const SIDEBAR_LINK_SELECTOR = "a[href^='/search/'], a[href^='/page/']"
const SIDEBAR_SCROLL_CONTAINER_SELECTORS = [".group\\/sidebar", "aside", "nav"]
const THREAD_TITLE_SELECTOR =
  ".h-headerHeight.fixed.z-10 .cursor-pointer.transition.duration-300.hover\\:opacity-70, input[placeholder='Untitled']"

const QUERY_EDIT_BUTTON_SELECTOR = 'button[data-testid="edit-query-button"]'
const THREAD_LIST_ENDPOINT_PATH = "/rest/thread/list_ask_threads?version=2.18&source=default"
const THREAD_LIST_PAGE_SIZE = 100
const THREAD_LIST_MAX_PAGES = 5
const THREAD_LIST_CACHE_TTL_MS = 5 * 60 * 1000

const EXPORT_ROLE_ATTR = "data-gh-perplexity-export-role"
const EXPORT_USER_SELECTOR = `[${EXPORT_ROLE_ATTR}="user"]`
const EXPORT_ASSISTANT_SELECTOR = `[${EXPORT_ROLE_ATTR}="assistant"]`

interface PerplexityThreadListEntry {
  slug?: unknown
  title?: unknown
}

function getPerplexityOrigin(): string {
  if (typeof window !== "undefined" && HOSTNAMES.has(window.location.hostname)) {
    return window.location.origin
  }

  return "https://www.perplexity.ai"
}

function buildPerplexityUrl(pathname: string): string {
  return new URL(pathname, getPerplexityOrigin()).toString()
}

export class PerplexityAdapter extends SiteAdapter {
  private threadListCache: ConversationInfo[] = []
  private threadListCacheExpiresAt = 0

  match(): boolean {
    return HOSTNAMES.has(window.location.hostname)
  }

  getSiteId(): string {
    return SITE_IDS.PERPLEXITY
  }

  getName(): string {
    return "Perplexity"
  }

  getThemeColors(): { primary: string; secondary: string } {
    return { primary: "#1fb8cd", secondary: "#1597aa" }
  }

  getSessionId(): string {
    const match = window.location.pathname.match(THREAD_PATH_PATTERN)
    const slug = match?.[1]?.trim() || ""
    return slug === "new" ? "" : slug
  }

  isNewConversation(): boolean {
    const path = window.location.pathname.replace(/\/+$/, "") || "/"
    return path === "/" || NEW_THREAD_PATH_PATTERN.test(path) || !THREAD_PATH_PATTERN.test(path)
  }

  getNewTabUrl(): string {
    return buildPerplexityUrl("/")
  }

  getSessionName(): string | null {
    const title = document.title.trim()
    if (!title) return null

    const cleaned = title
      .replace(/\s*[-|]\s*Perplexity$/i, "")
      .replace(/\s*[-|]\s*Perplexity AI$/i, "")
      .trim()

    if (!cleaned || /^perplexity(?:\s+ai)?$/i.test(cleaned)) {
      return null
    }

    return cleaned
  }

  getConversationTitle(): string | null {
    const titleElement = document.querySelector(THREAD_TITLE_SELECTOR)
    const title =
      titleElement instanceof HTMLInputElement
        ? titleElement.value.trim()
        : titleElement?.textContent?.trim() || ""

    return title || this.getSessionName()
  }

  getTextareaSelectors(): string[] {
    return [...TEXTAREA_SELECTORS]
  }

  isValidTextarea(element: HTMLElement): boolean {
    if (!super.isValidTextarea(element)) return false

    if (element.id === "ask-input") return true
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return true

    return (
      element.isContentEditable &&
      (element.getAttribute("role") === "textbox" ||
        element.getAttribute("g_editable") === "true" ||
        element.closest("form") !== null)
    )
  }

  insertPrompt(content: string): boolean {
    const editor = this.getTextareaElement()
    if (!editor || !editor.isConnected) return false

    editor.focus()

    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      this.setTextEntryValue(editor, content)
      editor.dispatchEvent(
        new InputEvent("input", { bubbles: true, composed: true, data: content }),
      )
      editor.dispatchEvent(new Event("change", { bubbles: true }))
      if (editor instanceof HTMLTextAreaElement) {
        editor.setSelectionRange(content.length, content.length)
      }
      return true
    }

    const richEditor = editor as HTMLElement
    this.selectEditorContents(richEditor)

    try {
      document.execCommand("delete", false)
    } catch {
      // ignore legacy API failure and continue with fallbacks
    }

    try {
      if (document.execCommand("insertText", false, content)) {
        this.dispatchEditorInputEvents(richEditor, content, "insertText")
        this.placeCaretAtEnd(richEditor)
        return true
      }
    } catch {
      // fallback below
    }

    if (this.dispatchPasteEvent(richEditor, content)) {
      this.placeCaretAtEnd(richEditor)
      return true
    }

    richEditor.textContent = content
    this.dispatchEditorInputEvents(richEditor, content, "insertText")
    this.placeCaretAtEnd(richEditor)
    return true
  }

  clearTextarea(): void {
    const editor = this.getTextareaElement()
    if (!editor || !editor.isConnected) return

    editor.focus()

    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      this.setTextEntryValue(editor, "")
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: "" }))
      editor.dispatchEvent(new Event("change", { bubbles: true }))
      if (editor instanceof HTMLTextAreaElement) {
        editor.setSelectionRange(0, 0)
      }
      return
    }

    const richEditor = editor as HTMLElement
    this.selectEditorContents(richEditor)

    try {
      document.execCommand("delete", false)
    } catch {
      // fallback below
    }

    richEditor.textContent = ""
    this.dispatchEditorInputEvents(richEditor, "", "deleteContentBackward")
    this.placeCaretAtEnd(richEditor)
  }

  getSubmitButtonSelectors(): string[] {
    return [`${SUBMIT_BUTTON_SELECTOR}:not([disabled])`]
  }

  findSubmitButton(editor: HTMLElement | null): HTMLElement | null {
    const scopes = [
      editor?.closest("form"),
      editor?.parentElement,
      editor?.closest(".grow.block"),
      document.body,
    ].filter(Boolean) as ParentNode[]

    for (const scope of scopes) {
      const candidates = scope.querySelectorAll(SUBMIT_BUTTON_SELECTOR)
      for (const candidate of Array.from(candidates)) {
        const button = candidate as HTMLElement
        if (!this.isVisibleElement(button) || this.isDisabledActionButton(button)) continue
        return button
      }
    }

    return super.findSubmitButton(editor)
  }

  getUsageCounterMountAnchor(
    editor: HTMLElement,
    submitButton: HTMLElement | null,
  ): HTMLElement | null {
    const candidates = [
      editor.closest(".grow.block"),
      submitButton?.closest(".grow.block") || null,
      DOMToolkit.closestComposed(editor, ".grow.block"),
      submitButton ? DOMToolkit.closestComposed(submitButton, ".grow.block") : null,
      editor.closest("[role='tabpanel']"),
      submitButton?.closest("[role='tabpanel']") || null,
    ].filter(Boolean) as HTMLElement[]

    for (const candidate of candidates) {
      const safeAnchor = this.promoteUsageCounterAnchor(candidate)
      if (safeAnchor?.parentElement) {
        return safeAnchor
      }
    }

    return null
  }

  getStopButtonSelectors(): string[] {
    return [STOP_BUTTON_SELECTOR]
  }

  isGenerating(): boolean {
    const stopButton = this.findVisibleElementBySelectors(this.getStopButtonSelectors())
    return Boolean(stopButton)
  }

  getNewChatButtonSelectors(): string[] {
    return [...NEW_CHAT_BUTTON_SELECTORS]
  }

  getScrollContainer(): HTMLElement | null {
    const selectors = RESPONSE_CONTAINER_SELECTOR.split(",").map((selector) => selector.trim())

    for (const selector of selectors) {
      const candidates = document.querySelectorAll(selector)
      for (const candidate of Array.from(candidates)) {
        const element = candidate as HTMLElement
        if (element.scrollHeight > element.clientHeight + 40) {
          return element
        }
      }
    }

    return document.scrollingElement as HTMLElement | null
  }

  getSidebarScrollContainer(): Element | null {
    for (const selector of SIDEBAR_SCROLL_CONTAINER_SELECTORS) {
      const candidate = document.querySelector(selector)
      if (!(candidate instanceof HTMLElement)) continue

      const scrollable = this.findScrollableParent(candidate)
      if (scrollable) return scrollable
      return candidate
    }

    return document.scrollingElement
  }

  getConversationList(): ConversationInfo[] {
    const domList = this.collectConversationListFromDom()
    const cachedList = this.getCachedThreadList()
    const currentConversation = this.getCurrentConversationInfo()
    const currentList = currentConversation ? [currentConversation] : []

    if (domList.length === 0 && cachedList.length === 0) return currentList
    if (domList.length === 0) return this.mergeConversationInfos(cachedList, currentList)
    if (cachedList.length === 0) return this.mergeConversationInfos(domList, currentList)

    return this.mergeConversationInfos(cachedList, domList, currentList)
  }

  getConversationObserverConfig(): ConversationObserverConfig | null {
    return {
      selector: SIDEBAR_LINK_SELECTOR,
      shadow: false,
      extractInfo: (element) => this.extractConversationInfo(element),
      getTitleElement: (element) => element.querySelector("span, div[dir='auto']") || element,
    }
  }

  async loadAllConversations(): Promise<void> {
    try {
      const apiThreads = await this.fetchThreadsViaApi()
      if (apiThreads.length > 0) {
        this.cacheThreadList(apiThreads)
      }
    } catch (error) {
      console.warn("[PerplexityAdapter] Failed to preload thread list:", error)
    }
  }

  navigateToConversation(id: string, url?: string): boolean {
    return super.navigateToConversation(id, url || buildPerplexityUrl(`/search/${id}`))
  }

  getResponseContainerSelector(): string {
    return RESPONSE_CONTAINER_SELECTOR
  }

  getChatContentSelectors(): string[] {
    return [USER_QUERY_SELECTOR, ASSISTANT_MESSAGE_SELECTOR]
  }

  getUserQuerySelector(): string | null {
    return USER_QUERY_SELECTOR
  }

  extractUserQueryText(element: Element): string {
    const source = (this.findUserContentRoot(element) || element).cloneNode(true) as HTMLElement
    source
      .querySelectorAll(
        ".gh-user-query-markdown, button, [role='button'], svg, [aria-hidden='true'], [data-testid]",
      )
      .forEach((node) => node.remove())

    return this.extractTextWithLineBreaks(source).trim()
  }

  extractUserQueryMarkdown(element: Element): string {
    return this.extractUserQueryText(element)
  }

  extractUserQueryExportContent(element: Element): string {
    return this.extractUserQueryMarkdown(element)
  }

  replaceUserQueryContent(element: Element, html: string): boolean {
    const contentRoot = this.findUserContentRoot(element)
    if (!contentRoot) return false
    if (element.querySelector(".gh-user-query-markdown")) return false

    const rendered = document.createElement("div")
    rendered.className =
      `${contentRoot.className || ""} gh-user-query-markdown gh-markdown-preview`.trim()
    rendered.innerHTML = html

    const inlineStyle = contentRoot.getAttribute("style")
    if (inlineStyle) {
      rendered.setAttribute("style", inlineStyle)
    }

    contentRoot.classList.add("gh-user-query-raw")
    contentRoot.style.display = "none"
    contentRoot.after(rendered)
    return true
  }

  extractAssistantResponseText(element: Element): string {
    const clone = element.cloneNode(true) as HTMLElement
    clone
      .querySelectorAll(
        "button, [role='button'], svg, [aria-hidden='true'], .gh-user-query-markdown, [data-testid='copy-code-button']",
      )
      .forEach((node) => node.remove())

    const markdown = htmlToMarkdown(clone) || this.extractTextWithLineBreaks(clone)
    return markdown.trim()
  }

  getAssistantMermaidSupportMode(): "native" | "fallback" | "unsupported" {
    return "fallback"
  }

  getExportConfig(): ExportConfig {
    return {
      userQuerySelector: EXPORT_USER_SELECTOR,
      assistantResponseSelector: EXPORT_ASSISTANT_SELECTOR,
      turnSelector: null,
      useShadowDOM: false,
    }
  }

  async prepareConversationExport(): Promise<unknown> {
    this.clearExportMarkers()
    const container =
      document.querySelector("[role='tabpanel']") || document.querySelector("main") || document.body
    this.markExportMessages(container)
    return null
  }

  async restoreConversationAfterExport(): Promise<void> {
    this.clearExportMarkers()
  }

  extractOutline(maxLevel = 6, includeUserQueries = false, showWordCount = false): OutlineItem[] {
    const outline: OutlineItem[] = []
    const container =
      document.querySelector("[role='tabpanel']") ||
      document.querySelector(this.getResponseContainerSelector())
    if (!container) return outline

    const userQuerySelector = this.getUserQuerySelector()
    if (!userQuerySelector) return outline

    const headingSelectors = Array.from({ length: maxLevel }, (_, index) => `h${index + 1}`).join(
      ", ",
    )
    const rawUserQueries = Array.from(container.querySelectorAll(userQuerySelector))
    const userQueries = this.collectTopLevelBlocks(rawUserQueries).filter(
      (element) => !this.shouldSkipOutlineElement(element),
    )
    const userQuerySet = new Set(userQueries)

    const allElements = Array.from(
      container.querySelectorAll(`${userQuerySelector}, ${headingSelectors}`),
    ).filter((element) => {
      if (element.matches(userQuerySelector)) {
        return userQuerySet.has(element)
      }

      return (
        !this.shouldSkipOutlineElement(element) &&
        element.closest(ASSISTANT_MESSAGE_SELECTOR) !== null
      )
    })

    allElements.forEach((element, index) => {
      const isUserQuery = element.matches(userQuerySelector)
      const tagName = element.tagName.toLowerCase()

      if (isUserQuery) {
        if (!includeUserQueries) return

        const fullText = this.extractUserQueryText(element)
        if (!fullText) return

        const item: OutlineItem = {
          level: 0,
          text: this.truncateText(fullText, 80),
          element,
          isUserQuery: true,
          isTruncated: fullText.length > 80,
        }

        if (showWordCount) {
          const nextUserQuery =
            allElements
              .slice(index + 1)
              .find((candidate) => candidate.matches(userQuerySelector)) || null
          item.wordCount = this.calculateAssistantWordCountBetween(
            container,
            element,
            nextUserQuery,
          )
        }

        outline.push(item)
        return
      }

      if (!/^h[1-6]$/.test(tagName)) return

      const level = parseInt(tagName.charAt(1), 10)
      if (Number.isNaN(level) || level > maxLevel) return

      const text = element.textContent?.trim() || ""
      if (!text) return

      const item: OutlineItem = {
        level,
        text,
        element,
      }

      if (showWordCount) {
        let nextBoundary: Element | null = null
        for (let i = index + 1; i < allElements.length; i += 1) {
          const candidate = allElements[i]
          if (candidate.matches(userQuerySelector)) {
            nextBoundary = candidate
            break
          }

          const candidateTagName = candidate.tagName.toLowerCase()
          if (/^h[1-6]$/.test(candidateTagName)) {
            const candidateLevel = parseInt(candidateTagName.charAt(1), 10)
            if (!Number.isNaN(candidateLevel) && candidateLevel <= level) {
              nextBoundary = candidate
              break
            }
          }
        }

        item.wordCount = this.calculateRangeWordCount(
          element,
          nextBoundary,
          element.closest(ASSISTANT_MESSAGE_SELECTOR) || container,
        )
      }

      outline.push(item)
    })

    return outline
  }

  getNetworkMonitorConfig(): NetworkMonitorConfig | null {
    return {
      urlPatterns: ["/rest/sse/perplexity_ask"],
      silenceThreshold: 2500,
    }
  }

  getWidthSelectors(): Array<{ selector: string; property: string }> {
    return [
      { selector: "[role='tabpanel'] .mx-auto", property: "maxWidth" },
      { selector: "main .mx-auto", property: "maxWidth" },
    ]
  }

  getUserQueryWidthSelectors(): Array<{ selector: string; property: string }> {
    return [{ selector: USER_QUERY_SELECTOR, property: "maxWidth" }]
  }

  private selectEditorContents(editor: HTMLElement): void {
    const selection = window.getSelection()
    if (!selection) return

    const range = document.createRange()
    range.selectNodeContents(editor)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  private placeCaretAtEnd(editor: HTMLElement): void {
    const selection = window.getSelection()
    if (!selection) return

    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  private dispatchEditorInputEvents(
    editor: HTMLElement,
    data: string,
    inputType: InputEvent["inputType"],
  ): void {
    try {
      editor.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          composed: true,
          data,
          inputType,
        }),
      )
    } catch {
      // ignore browsers that reject synthetic beforeinput
    }

    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        data,
        inputType,
      }),
    )
    editor.dispatchEvent(new Event("change", { bubbles: true }))
  }

  private dispatchPasteEvent(editor: HTMLElement, content: string): boolean {
    if (typeof DataTransfer === "undefined" || typeof ClipboardEvent === "undefined") {
      return false
    }

    try {
      const dataTransfer = new DataTransfer()
      dataTransfer.setData("text/plain", content)

      return editor.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clipboardData: dataTransfer,
        }),
      )
    } catch {
      return false
    }
  }

  private findScrollableParent(element: Element | null): HTMLElement | null {
    let current = element instanceof HTMLElement ? element : element?.parentElement || null

    while (current && current !== document.body) {
      if (current.scrollHeight > current.clientHeight + 20) {
        return current
      }
      current = current.parentElement
    }

    return null
  }

  private parseThreadSlugFromUrl(url: string): string {
    try {
      const parsed = new URL(url, window.location.origin)
      const match = parsed.pathname.match(THREAD_PATH_PATTERN)
      const slug = match?.[1]?.trim() || ""
      return slug === "new" ? "" : slug
    } catch {
      return ""
    }
  }

  private extractConversationInfo(element: Element): ConversationInfo | null {
    const anchor = element.closest("a") as HTMLAnchorElement | null
    if (!anchor) return null

    const slug = this.parseThreadSlugFromUrl(anchor.href || anchor.getAttribute("href") || "")
    if (!slug) return null

    const title = this.extractConversationTitle(anchor, slug)

    return {
      id: slug,
      title,
      url: new URL(anchor.getAttribute("href") || anchor.href, window.location.origin).toString(),
      isActive: slug === this.getSessionId(),
    }
  }

  private collectConversationListFromDom(): ConversationInfo[] {
    const root =
      (this.getSidebarScrollContainer() as ParentNode | null) ||
      document.querySelector(".group\\/sidebar") ||
      document.querySelector("aside") ||
      document
    const links = root.querySelectorAll(SIDEBAR_LINK_SELECTOR)
    const result = new Map<string, ConversationInfo>()

    links.forEach((link) => {
      const info = this.extractConversationInfo(link)
      if (!info) return
      result.set(info.id, info)
    })

    return Array.from(result.values())
  }

  private getCachedThreadList(): ConversationInfo[] {
    if (Date.now() > this.threadListCacheExpiresAt) {
      return []
    }
    return [...this.threadListCache]
  }

  private cacheThreadList(list: ConversationInfo[]): void {
    this.threadListCache = list
    this.threadListCacheExpiresAt = Date.now() + THREAD_LIST_CACHE_TTL_MS
  }

  private mergeConversationInfos(...lists: ConversationInfo[][]): ConversationInfo[] {
    const merged = new Map<string, ConversationInfo>()
    const currentSessionId = this.getSessionId()

    for (const list of lists) {
      for (const item of list) {
        const existing = merged.get(item.id)
        const preferredTitle = this.pickPreferredConversationTitle(
          existing?.title,
          item.title,
          item.id,
        )
        merged.set(item.id, {
          ...existing,
          ...item,
          title: preferredTitle,
          url: item.url || existing?.url || buildPerplexityUrl(`/search/${item.id}`),
          isActive: currentSessionId ? item.id === currentSessionId : false,
        })
      }
    }

    return Array.from(merged.values())
  }

  private async fetchThreadsViaApi(): Promise<ConversationInfo[]> {
    const results: ConversationInfo[] = []
    const seen = new Set<string>()
    const currentSessionId = this.getSessionId()

    for (let page = 0; page < THREAD_LIST_MAX_PAGES; page += 1) {
      const response = await fetch(buildPerplexityUrl(THREAD_LIST_ENDPOINT_PATH), {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          limit: THREAD_LIST_PAGE_SIZE,
          offset: page * THREAD_LIST_PAGE_SIZE,
          search_term: "",
          with_temporary_threads: false,
        }),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = JSON.parse(await response.text()) as PerplexityThreadListEntry[]
      if (!Array.isArray(data) || data.length === 0) break

      for (const entry of data) {
        const slug = typeof entry?.slug === "string" ? entry.slug.trim() : ""
        if (!slug || slug === "new" || seen.has(slug)) continue

        seen.add(slug)
        results.push({
          id: slug,
          title: this.normalizeConversationTitle(
            typeof entry?.title === "string" ? entry.title : "",
            slug,
          ),
          url: buildPerplexityUrl(`/search/${slug}`),
          isActive: slug === currentSessionId,
        })
      }

      if (data.length < THREAD_LIST_PAGE_SIZE) {
        break
      }

      await new Promise((resolve) => setTimeout(resolve, 150))
    }

    return results
  }

  private findUserContentRoot(element: Element): HTMLElement | null {
    const candidates = Array.from(element.querySelectorAll(USER_QUERY_CONTENT_SELECTOR)).filter(
      (candidate) => candidate instanceof HTMLElement,
    ) as HTMLElement[]

    let best: HTMLElement | null = null
    let bestScore = 0

    for (const candidate of candidates) {
      const root =
        candidate.matches("[data-lexical-text='true']") && candidate.parentElement
          ? candidate.parentElement
          : candidate
      const text = (root.innerText || root.textContent || "").trim()
      if (!text) continue

      if (text.length > bestScore) {
        best = root as HTMLElement
        bestScore = text.length
      }
    }

    return best
  }

  private clearExportMarkers(): void {
    document
      .querySelectorAll(`[${EXPORT_ROLE_ATTR}]`)
      .forEach((node) => node.removeAttribute(EXPORT_ROLE_ATTR))
  }

  private markExportMessages(container: Element): void {
    const users = this.collectTopLevelBlocks(
      Array.from(container.querySelectorAll(USER_QUERY_SELECTOR)).filter(
        (element) => !this.shouldSkipExportElement(element),
      ),
    )
    const assistants = this.collectTopLevelBlocks(
      Array.from(container.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR)).filter(
        (element) =>
          !this.shouldSkipExportElement(element) && !element.closest(USER_QUERY_SELECTOR),
      ),
    )

    users.forEach((element) => element.setAttribute(EXPORT_ROLE_ATTR, "user"))
    assistants.forEach((element) => element.setAttribute(EXPORT_ROLE_ATTR, "assistant"))
  }

  private shouldSkipExportElement(element: Element): boolean {
    return (
      element.closest(".gh-root") !== null ||
      element.closest(".gh-user-query-markdown") !== null ||
      element.matches(QUERY_EDIT_BUTTON_SELECTOR)
    )
  }

  private shouldSkipOutlineElement(element: Element): boolean {
    const userQueryAncestor = element.closest(USER_QUERY_SELECTOR)

    return (
      element.closest(".gh-root") !== null ||
      element.closest(".gh-user-query-markdown") !== null ||
      (userQueryAncestor !== null && !element.matches(USER_QUERY_SELECTOR))
    )
  }

  private setTextEntryValue(editor: HTMLTextAreaElement | HTMLInputElement, value: string): void {
    const prototype =
      editor instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set

    if (setter) {
      setter.call(editor, value)
    } else {
      editor.value = value
    }
  }

  private collectTopLevelBlocks<T extends Element>(elements: T[]): T[] {
    return elements.filter(
      (element) => !elements.some((other) => other !== element && other.contains(element)),
    )
  }

  private calculateAssistantWordCountBetween(
    container: Element,
    startElement: Element,
    nextUserQuery: Element | null,
  ): number {
    let total = 0
    const assistants = Array.from(container.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR))

    for (const assistant of assistants) {
      const afterStart = Boolean(
        startElement.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING,
      )
      if (!afterStart) continue

      if (nextUserQuery) {
        const beforeEnd = Boolean(
          nextUserQuery.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_PRECEDING,
        )
        if (!beforeEnd) continue
      }

      total += this.extractAssistantResponseText(assistant).length
    }

    return total
  }

  private promoteUsageCounterAnchor(candidate: HTMLElement | null): HTMLElement | null {
    let current = candidate

    for (let depth = 0; current && depth < 4; depth += 1) {
      if (!current.parentElement) return null

      const parent = current.parentElement
      const parentStyle = window.getComputedStyle(parent)
      const isRowFlex =
        parentStyle.display.includes("flex") && !parentStyle.flexDirection.startsWith("column")

      if (!isRowFlex) {
        return current
      }

      current = parent
    }

    return candidate
  }

  private extractConversationTitle(anchor: HTMLAnchorElement, slug: string): string {
    const candidates: Array<{ text: string; score: number }> = []
    const row =
      anchor.closest("li") ||
      anchor.closest("[role='listitem']") ||
      anchor.closest(".group") ||
      anchor.parentElement

    const directCandidates = [
      anchor.getAttribute("title"),
      anchor.getAttribute("aria-label"),
      row instanceof HTMLElement ? row.getAttribute("title") : null,
      row instanceof HTMLElement ? row.getAttribute("aria-label") : null,
      anchor.textContent,
      row?.textContent || null,
    ]

    directCandidates.forEach((value, index) => {
      const normalized = this.normalizeConversationTitle(value || "", slug)
      if (!normalized) return
      candidates.push({
        text: normalized,
        score: this.scoreConversationTitleCandidate(normalized, slug) + (6 - index),
      })
    })

    const scopedElements = [anchor, row].filter(Boolean) as Element[]
    const scopedSelectors = ["[data-testid*='title']", "[dir='auto']", ".truncate", "span", "div"]

    for (const scope of scopedElements) {
      for (const selector of scopedSelectors) {
        scope.querySelectorAll(selector).forEach((candidate) => {
          const normalized = this.normalizeConversationTitle(candidate.textContent || "", slug)
          if (!normalized) return
          candidates.push({
            text: normalized,
            score: this.scoreConversationTitleCandidate(normalized, slug),
          })
        })
      }
    }

    candidates.sort((left, right) => right.score - left.score)
    return candidates[0]?.text || slug
  }

  private normalizeConversationTitle(rawTitle: string, slug: string): string {
    const normalized = rawTitle.replace(/\s+/g, " ").trim()
    if (!normalized) return ""
    if (normalized === "/" || normalized === "..." || normalized === "···") return ""
    if (/^\(\d+\)$/.test(normalized)) return ""
    if (normalized === slug) return slug
    return normalized
  }

  private pickPreferredConversationTitle(
    existingTitle: string | undefined,
    incomingTitle: string | undefined,
    slug: string,
  ): string {
    const existing = this.normalizeConversationTitle(existingTitle || "", slug)
    const incoming = this.normalizeConversationTitle(incomingTitle || "", slug)

    if (!incoming) return existing || slug
    if (!existing) return incoming || slug
    if (existing === incoming) return incoming

    const existingIsSlug = this.isLikelySlugTitle(existing, slug)
    const incomingIsSlug = this.isLikelySlugTitle(incoming, slug)

    if (existingIsSlug && !incomingIsSlug) return incoming
    if (!existingIsSlug && incomingIsSlug) return existing

    return incoming
  }

  private scoreConversationTitleCandidate(title: string, slug: string): number {
    let score = 0

    if (!this.isLikelySlugTitle(title, slug)) score += 100
    if (/[\u3400-\u9fff]/.test(title)) score += 40
    if (/\s/.test(title)) score += 15
    if (title.length >= 6) score += Math.min(title.length, 60)
    if (title.length > 120) score -= 20
    if (/^(answer|share|thread|search)$/i.test(title)) score -= 80

    return score
  }

  private isLikelySlugTitle(title: string, slug?: string): boolean {
    const normalized = title.trim().toLowerCase()
    const normalizedSlug = slug?.trim().toLowerCase() || ""

    if (!normalized) return true
    if (/[\u3400-\u9fff]/.test(normalized)) return false
    if (normalizedSlug && normalized === normalizedSlug) return true
    if (normalized.includes(" ") && !/^[a-z0-9][a-z0-9 -]*$/i.test(normalized)) return false

    return /^[a-z0-9]+(?:-[a-z0-9]+){2,}(?:-[a-z0-9_-]{4,})?$/i.test(normalized)
  }

  private truncateText(text: string, maxLength: number): string {
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
  }

  private isVisibleElement(element: HTMLElement | null): boolean {
    if (!element) return false
    if (element.offsetParent !== null) return true

    const style = window.getComputedStyle(element)
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false
    }

    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  private isDisabledActionButton(element: HTMLElement | null): boolean {
    if (!element) return true
    return (
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      element.classList.contains("disabled")
    )
  }
}
