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
  type ConversationDeleteTarget,
  type ConversationObserverConfig,
  type ExportConfig,
  type ModelSwitcherConfig,
  type NetworkMonitorConfig,
  type OutlineItem,
  type SiteDeleteConversationResult,
  type ZenModeConfig,
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
const THREAD_LIST_REQUEST_TIMEOUT_MS = 10_000
const DELETE_FLOW_TIMEOUT_MS = 5_000

const THREAD_ACTION_BUTTON_SELECTORS = [
  'button[aria-label="Thread actions"]',
  'button[aria-label*="Thread actions" i]',
  'button[aria-label*="话题"]',
  'button[aria-label*="对话"]',
  'button[aria-label*="线程"]',
]

const DELETE_MENU_ITEM_LABELS = ["Delete", "删除"]
const CONFIRM_BUTTON_LABELS = ["Confirm", "确认", "Delete", "删除"]

const THREAD_ACTION_LABELS = ["Thread actions", "话题操作", "对话操作", "线程操作"]

const ZEN_MODE_HIDE_SELECTORS = [
  ".group\\/sidebar",
  "aside",
  'nav:has(a[href^="/search/"])',
  'nav:has(a[href^="/page/"])',
]
const CLEAN_MODE_HIDE_SELECTORS = [
  "footer",
  "[data-testid='disclaimer']",
  "[data-testid='assistant-disclaimer']",
  "[data-testid='legal-disclaimer']",
]

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
  private loadAllConversationsPromise: Promise<void> | null = null

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

  async deleteConversationOnSite(
    target: ConversationDeleteTarget,
  ): Promise<SiteDeleteConversationResult> {
    const success = await this.deleteConversationViaUi(target.id)

    return {
      id: target.id,
      success,
      method: success ? "ui" : "none",
      reason: success ? undefined : "ui_failed",
    }
  }

  async loadAllConversations(): Promise<void> {
    if (this.loadAllConversationsPromise) {
      return this.loadAllConversationsPromise
    }

    this.loadAllConversationsPromise = (async () => {
      try {
        const apiThreads = await this.fetchThreadsViaApi()
        if (apiThreads.length > 0) {
          this.cacheThreadList(apiThreads)
        }
      } catch (error) {
        console.warn("[PerplexityAdapter] Failed to preload thread list:", error)
      } finally {
        this.loadAllConversationsPromise = null
      }
    })()

    return this.loadAllConversationsPromise
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

  getLatestReplyText(): string | null {
    const responses = this.collectTopLevelBlocks(
      Array.from(document.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR)).filter(
        (element) =>
          !this.shouldSkipExportElement(element) && !element.closest(USER_QUERY_SELECTOR),
      ),
    )
    const last = responses[responses.length - 1]
    return last ? this.extractAssistantResponseText(last) : null
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

    const headings = this.collectOutlineHeadingCandidates(container, maxLevel)
    const rawUserQueries = Array.from(container.querySelectorAll(userQuerySelector))
    const userQueries = this.dedupeUserQueries(
      this.collectTopLevelBlocks(rawUserQueries).filter(
        (element) =>
          !this.shouldSkipOutlineElement(element) && this.isValidUserQueryCandidate(element),
      ),
      container,
    )
    const userQuerySet = new Set(userQueries)
    const userQueryKeyCounts = new Map<string, number>()
    const headingKeyCounts = new Map<string, number>()
    let currentGroupId = "preamble"

    const allElements = [...userQueries, ...headings].sort((left, right) =>
      this.compareElementsByDocumentOrder(left, right),
    )

    allElements.forEach((element, index) => {
      const isUserQuery = element.matches(userQuerySelector)
      const headingLevel = isUserQuery ? null : this.getOutlineHeadingLevel(element)

      if (element.matches(userQuerySelector)) {
        if (!userQuerySet.has(element)) {
          return
        }
      } else if (headingLevel === null) {
        return
      }

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
        item.id = this.buildOutlineOccurrenceId(
          "query",
          this.normalizeUiText(fullText),
          userQueryKeyCounts,
        )
        currentGroupId = item.id

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

      const text = element.textContent?.trim() || ""
      if (!text) return

      const item: OutlineItem = {
        level: headingLevel,
        text,
        element,
      }
      item.id = this.buildOutlineOccurrenceId(
        `heading::${currentGroupId}::${headingLevel}`,
        this.normalizeUiText(text),
        headingKeyCounts,
      )

      if (showWordCount) {
        let nextBoundary: Element | null = null
        for (let i = index + 1; i < allElements.length; i += 1) {
          const candidate = allElements[i]
          if (candidate.matches(userQuerySelector)) {
            nextBoundary = candidate
            break
          }

          const candidateLevel = this.getOutlineHeadingLevel(candidate)
          if (candidateLevel !== null && candidateLevel <= headingLevel) {
            nextBoundary = candidate
            break
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

  getZenModeConfig(): ZenModeConfig | null {
    return {
      hide: [...ZEN_MODE_HIDE_SELECTORS],
      styles: [
        { selector: ":root", property: "--sidebar-pinned-width", value: "0px" },
        {
          selector: "main",
          property: "padding-left",
          value: "0px",
          extraCss: "padding-right: 0 !important; width: 100% !important;",
        },
        {
          selector: "[role='tabpanel']",
          property: "max-width",
          value: "none",
          extraCss: "width: 100% !important;",
        },
        {
          selector: "main .mx-auto",
          property: "max-width",
          value: "min(1120px, calc(100vw - 48px))",
        },
      ],
    }
  }

  getCleanModeConfig(): ZenModeConfig | null {
    return {
      hide: [...CLEAN_MODE_HIDE_SELECTORS],
    }
  }

  getModelSwitcherConfig(keyword: string): ModelSwitcherConfig | null {
    return {
      targetModelKeyword: keyword,
      selectorButtonSelectors: [
        'button[aria-label="Select AI model"]',
        'button[aria-label*="Select AI model" i]',
        'button[aria-label*="model" i]',
        'button[aria-label*="模型"]',
      ],
      menuItemSelector: "[role='menuitemradio'], [role='menuitemcheckbox'], [role='menuitem']",
      checkInterval: 1000,
      maxAttempts: 12,
      menuRenderDelay: 200,
    }
  }

  async toggleTheme(targetMode: "light" | "dark" | "system"): Promise<boolean> {
    try {
      const root = document.documentElement
      const resolvedMode =
        targetMode === "system"
          ? window.matchMedia?.("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : targetMode

      root.setAttribute("data-color-scheme", resolvedMode)
      document.body.setAttribute("data-color-scheme", resolvedMode)

      root.classList.toggle("dark", resolvedMode === "dark")
      root.classList.toggle("light", resolvedMode === "light")
      document.body.classList.toggle("dark", resolvedMode === "dark")
      document.body.classList.toggle("light", resolvedMode === "light")
      root.style.colorScheme = resolvedMode

      try {
        localStorage.setItem("theme", targetMode)
        localStorage.setItem("appearance", targetMode)
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "theme",
            newValue: targetMode,
            storageArea: localStorage,
          }),
        )
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "appearance",
            newValue: targetMode,
            storageArea: localStorage,
          }),
        )
      } catch {
        // ignore localStorage access issues
      }

      return true
    } catch (error) {
      console.error("[PerplexityAdapter] toggleTheme error:", error)
      return false
    }
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

  private async deleteConversationViaUi(id: string): Promise<boolean> {
    const sidebarLink = await this.waitForValue(() => this.findSidebarConversationLink(id), 600)
    if (sidebarLink) {
      const container = this.findConversationItemContainer(sidebarLink)
      const actionButton = await this.openThreadActionMenu({
        preferredContainer: container,
        triggerScope: container || sidebarLink,
      })

      if (actionButton && (await this.confirmDeleteFromOpenMenu())) {
        this.syncConversationListAfterDelete(id)
        return true
      }
    }

    if (this.getSessionId() !== id && !this.navigateToConversation(id)) {
      return false
    }

    const ready = await this.waitForCondition(
      () => this.getSessionId() === id,
      DELETE_FLOW_TIMEOUT_MS,
    )
    if (!ready) return false

    const actionButton = await this.openThreadActionMenu({
      preferredContainer: document.querySelector(
        ".h-headerHeight.fixed.z-10",
      ) as HTMLElement | null,
      triggerScope: document.body,
    })
    if (!actionButton) return false

    const deleted = await this.confirmDeleteFromOpenMenu()
    if (deleted) {
      this.syncConversationListAfterDelete(id)
    }

    return deleted
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

  private syncConversationListAfterDelete(id: string): void {
    this.threadListCache = this.threadListCache.filter((item) => item.id !== id)
    this.threadListCacheExpiresAt = Math.min(this.threadListCacheExpiresAt, Date.now() + 10_000)

    document.querySelectorAll(SIDEBAR_LINK_SELECTOR).forEach((element) => {
      const anchor = element as HTMLAnchorElement
      if (this.parseThreadSlugFromUrl(anchor.getAttribute("href") || anchor.href || "") !== id)
        return

      const container = this.findConversationItemContainer(anchor)
      ;(container || anchor).remove()
    })
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

  private findSidebarConversationLink(id: string): HTMLAnchorElement | null {
    const links = document.querySelectorAll(SIDEBAR_LINK_SELECTOR)
    for (const link of Array.from(links)) {
      const anchor = link as HTMLAnchorElement
      const slug = this.parseThreadSlugFromUrl(anchor.getAttribute("href") || anchor.href || "")
      if (slug === id) {
        return anchor
      }
    }

    return null
  }

  private findConversationItemContainer(anchor: Element | null): HTMLElement | null {
    if (!(anchor instanceof HTMLElement)) return null

    return (anchor.closest("li") ||
      anchor.closest("[role='listitem']") ||
      anchor.closest(".group") ||
      anchor.parentElement) as HTMLElement | null
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
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), THREAD_LIST_REQUEST_TIMEOUT_MS)

      let responseText = ""

      try {
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
          signal: controller.signal,
        })

        responseText = await response.text()

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new Error(`Thread list request timed out after ${THREAD_LIST_REQUEST_TIMEOUT_MS}ms`)
        }

        throw error
      } finally {
        clearTimeout(timeoutId)
      }

      let data: PerplexityThreadListEntry[]
      try {
        data = JSON.parse(responseText) as PerplexityThreadListEntry[]
      } catch {
        const preview = responseText.replace(/\s+/g, " ").trim().slice(0, 160)
        throw new Error(`Invalid thread list response JSON${preview ? `: ${preview}` : ""}`)
      }

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

  private async openThreadActionMenu({
    preferredContainer,
    triggerScope,
  }: {
    preferredContainer: HTMLElement | null
    triggerScope: ParentNode
  }): Promise<HTMLElement | null> {
    if (preferredContainer) {
      this.revealConversationActions(preferredContainer)
    }

    const actionButton = await this.waitForValue(
      () => this.findThreadActionButton(preferredContainer, triggerScope),
      1500,
    )
    if (!actionButton) return null

    this.simulateClick(actionButton)

    const opened = await this.waitForCondition(
      () => this.findOpenDeleteMenuItem() !== null,
      DELETE_FLOW_TIMEOUT_MS,
    )
    return opened ? actionButton : null
  }

  private revealConversationActions(container: HTMLElement): void {
    const events = [
      new PointerEvent("pointerenter", { bubbles: true, composed: true }),
      new MouseEvent("mouseenter", { bubbles: true, composed: true }),
      new MouseEvent("mouseover", { bubbles: true, composed: true }),
    ]

    events.forEach((event) => container.dispatchEvent(event))
  }

  private findThreadActionButton(
    preferredContainer: HTMLElement | null,
    triggerScope: ParentNode,
  ): HTMLElement | null {
    const scopes = [preferredContainer, triggerScope, document.body].filter(Boolean) as ParentNode[]

    for (const scope of scopes) {
      for (const selector of THREAD_ACTION_BUTTON_SELECTORS) {
        const candidates = scope.querySelectorAll(selector)
        for (const candidate of Array.from(candidates)) {
          if (!(candidate instanceof HTMLElement)) continue
          if (!this.isVisibleElement(candidate)) continue
          if (this.matchesUiLabel(candidate, THREAD_ACTION_LABELS)) {
            return candidate
          }
        }
      }
    }

    return null
  }

  private async confirmDeleteFromOpenMenu(): Promise<boolean> {
    const deleteItem = await this.waitForValue(
      () => this.findOpenDeleteMenuItem(),
      DELETE_FLOW_TIMEOUT_MS,
    )
    if (!deleteItem) return false

    this.simulateClick(deleteItem)

    const confirmButton = await this.waitForValue(
      () => this.findConfirmationButton(),
      DELETE_FLOW_TIMEOUT_MS,
    )
    if (!confirmButton) return false

    this.simulateClick(confirmButton)

    await this.sleep(300)
    return true
  }

  private findOpenDeleteMenuItem(): HTMLElement | null {
    const menus = document.querySelectorAll("[role='menu'], [data-radix-popper-content-wrapper]")
    for (const menu of Array.from(menus)) {
      const buttons = menu.querySelectorAll("button, [role='menuitem'], [role='menuitemradio']")
      for (const button of Array.from(buttons)) {
        if (!(button instanceof HTMLElement)) continue
        if (this.matchesUiLabel(button, DELETE_MENU_ITEM_LABELS)) {
          return button
        }
      }
    }

    return null
  }

  private findConfirmationButton(): HTMLElement | null {
    const dialogs = document.querySelectorAll("[role='dialog'], [data-radix-portal]")
    for (const dialog of Array.from(dialogs)) {
      const buttons = dialog.querySelectorAll("button, [role='button']")
      for (const button of Array.from(buttons)) {
        if (!(button instanceof HTMLElement)) continue
        if (this.matchesUiLabel(button, CONFIRM_BUTTON_LABELS)) {
          return button
        }
      }
    }

    return null
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

  private dedupeUserQueries<T extends Element>(elements: T[], container: Element): T[] {
    if (elements.length <= 1) return elements

    const sorted = [...elements].sort((left, right) =>
      this.compareElementsByDocumentOrder(left, right),
    )
    const deduped: T[] = []

    for (const element of sorted) {
      const previous = deduped[deduped.length - 1]
      if (!previous) {
        deduped.push(element)
        continue
      }

      const previousText = this.normalizeUiText(this.extractUserQueryText(previous))
      const currentText = this.normalizeUiText(this.extractUserQueryText(element))
      if (
        previousText &&
        previousText === currentText &&
        !this.hasAssistantResponseBetween(container, previous, element)
      ) {
        deduped[deduped.length - 1] = element
        continue
      }

      deduped.push(element)
    }

    return deduped
  }

  private collectOutlineHeadingCandidates(container: Element, maxLevel: number): Element[] {
    const selectors = Array.from({ length: maxLevel }, (_, index) => {
      const level = index + 1
      return [`h${level}`, `[role='heading'][aria-level='${level}']`]
    }).flat()

    const candidates = Array.from(new Set(container.querySelectorAll(selectors.join(", "))))
    const assistantRoots = this.collectTopLevelBlocks(
      Array.from(container.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR)).filter(
        (element) =>
          !this.shouldSkipExportElement(element) && !element.closest(USER_QUERY_SELECTOR),
      ),
    )

    assistantRoots.forEach((root) => {
      root.querySelectorAll("p, li").forEach((element) => {
        if (this.isPseudoHeadingCandidate(element, maxLevel)) {
          candidates.push(element)
        }
      })
    })

    return this.collectTopLevelBlocks(
      Array.from(new Set(candidates)).filter((element) =>
        this.isOutlineHeadingCandidate(element, maxLevel),
      ),
    )
  }

  private isOutlineHeadingCandidate(element: Element, maxLevel: number): boolean {
    if (this.shouldSkipOutlineElement(element)) return false
    if (element.closest("nav, aside, header, footer, [role='dialog'], button, [role='button']")) {
      return false
    }

    const level = this.getOutlineHeadingLevel(element)
    if (level === null || level > maxLevel) return false

    const text = element.textContent?.trim() || ""
    return Boolean(text)
  }

  private getOutlineHeadingLevel(element: Element): number | null {
    const tagName = element.tagName.toLowerCase()
    if (/^h[1-6]$/.test(tagName)) {
      const level = parseInt(tagName.charAt(1), 10)
      return Number.isNaN(level) ? null : level
    }

    if (element.getAttribute("role") === "heading") {
      const rawLevel = parseInt(element.getAttribute("aria-level") || "", 10)
      return Number.isNaN(rawLevel) ? null : rawLevel
    }

    return this.inferPseudoHeadingLevel(element)
  }

  private compareElementsByDocumentOrder(left: Element, right: Element): number {
    if (left === right) return 0

    const position = left.compareDocumentPosition(right)
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1
    return 0
  }

  private hasAssistantResponseBetween(
    container: Element,
    startElement: Element,
    endElement: Element,
  ): boolean {
    const assistants = this.collectTopLevelBlocks(
      Array.from(container.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR)).filter(
        (element) =>
          !this.shouldSkipExportElement(element) && !element.closest(USER_QUERY_SELECTOR),
      ),
    )

    return assistants.some((assistant) => {
      const afterStart = Boolean(
        startElement.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING,
      )
      if (!afterStart) return false

      const beforeEnd = Boolean(
        endElement.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_PRECEDING,
      )
      return beforeEnd
    })
  }

  private buildOutlineOccurrenceId(
    prefix: string,
    key: string,
    counts: Map<string, number>,
  ): string {
    const safeKey = key || "untitled"
    const currentCount = counts.get(`${prefix}::${safeKey}`) || 0
    const nextCount = currentCount + 1
    counts.set(`${prefix}::${safeKey}`, nextCount)
    return `${prefix}::${safeKey}::${nextCount}`
  }

  private isValidUserQueryCandidate(element: Element): boolean {
    if (
      element.closest(
        ".h-headerHeight.fixed.z-10, header, nav, aside, [role='dialog'], .fixed, .sticky",
      )
    ) {
      return false
    }

    if (element.closest(ASSISTANT_MESSAGE_SELECTOR)) {
      return false
    }

    return Boolean(this.extractUserQueryText(element))
  }

  private isPseudoHeadingCandidate(element: Element, maxLevel: number): boolean {
    return (
      this.inferPseudoHeadingLevel(element) !== null &&
      this.isOutlineHeadingCandidate(element, maxLevel)
    )
  }

  private inferPseudoHeadingLevel(element: Element): number | null {
    if (!(element instanceof HTMLElement)) return null
    if (element.matches("li") && element.querySelector("ol, ul")) return null
    if (element.querySelector("h1, h2, h3, h4, h5, h6, [role='heading']")) return null
    if (element.closest("pre, code, table, blockquote")) return null

    const text = element.innerText.replace(/\s+/g, " ").trim()
    if (!text || text.length > 120) return null

    const chineseSectionPattern =
      /^(?:第[一二三四五六七八九十百千0-9]+(?:阶段|部分|章|节)|[一二三四五六七八九十百千]+[、.．:：])/
    if (chineseSectionPattern.test(text)) {
      return 1
    }

    const numberedPattern = text.match(/^(\d+(?:\.\d+){0,2})[、.)．:：]?\s+/)
    if (numberedPattern) {
      const depth = (numberedPattern[1].match(/\./g) || []).length
      return Math.min(depth + 2, 6)
    }

    const normalizedText = this.normalizeUiText(text)
    const strongText = this.normalizeUiText(
      Array.from(element.querySelectorAll("strong, b"))
        .map((node) => node.textContent || "")
        .join(" "),
    )
    const isMostlyStrong = Boolean(strongText) && strongText.length / normalizedText.length >= 0.85
    const looksLikeStandaloneTitle =
      text.length <= 36 &&
      !/[。！!；;]/.test(text) &&
      (!/[：:?？]$/.test(text) || text.length <= 48)

    if (isMostlyStrong && looksLikeStandaloneTitle) {
      return 1
    }

    return null
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

  private matchesUiLabel(element: HTMLElement, labels: string[]): boolean {
    const text = this.normalizeUiText(
      [
        element.textContent || "",
        element.getAttribute("aria-label") || "",
        element.getAttribute("title") || "",
      ].join(" "),
    )

    return labels.some((label) => {
      const normalized = this.normalizeUiText(label)
      return Boolean(normalized) && text.includes(normalized)
    })
  }

  private normalizeUiText(value: string): string {
    return value.replace(/\s+/g, " ").trim().toLowerCase()
  }

  private async waitForValue<T>(getter: () => T | null, timeoutMs: number): Promise<T | null> {
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      const value = getter()
      if (value) return value
      await this.sleep(80)
    }

    return null
  }

  private async waitForCondition(check: () => boolean, timeoutMs: number): Promise<boolean> {
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      if (check()) return true
      await this.sleep(80)
    }

    return false
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }
}
