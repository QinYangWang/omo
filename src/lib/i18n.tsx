import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

export type Lang = "zh" | "en";

const dict = {
  en: {
    add_local_dir: "Add a local directory",
    add_project: "Add project",
    back: "Back",
    choose_project: "Choose a project",
    choose_project_start: "Choose a project to start",
    import_desc:
      "Select an existing Pi session. A project-local fork will be created.",
    import_session: "Import session",
    import_title: "Import session to {name}",
    language: "Language",
    load_older: "Load older messages",
    local: "Local",
    new_project: "New project…",
    new_session: "New session",
    new_task: "New task",
    no_branch: "No branch",
    no_changes: "No changes",
    no_project: "Don't work in a project",
    open_surface: "Open a surface",
    open_surface_desc: "Choose what to show in the right panel",
    projects: "PROJECTS",
    prompt_placeholder: "Do anything… (paste images, @ files, / commands)",
    refresh: "Refresh",
    search: "Search",
    search_settings: "Search settings…",
    section_appearance: "Appearance",
    section_general: "General",
    section_packages: "Packages",
    section_providers: "Providers",
    section_skills: "Skills",
    section_usage: "Usage",
    select_model: "Select model",
    settings: "Settings",
    surface_browser: "Browser",
    surface_browser_desc: "Open a local app or URL",
    surface_files: "Files",
    surface_files_desc: "Browse and read workspace files",
    surface_review: "Review",
    surface_review_desc: "Review file changes",
    surface_terminal: "Terminal",
    surface_terminal_desc: "Start a shell in this workspace",
    theme: "Theme",
    theme_dark: "Dark",
    theme_light: "Light",
    theme_system: "System",
    tokens: "tokens",
    untitled: "Untitled session",
    usage_by_model: "Usage by model",
    usage_cache_savings: "Cache savings",
    usage_cached_input: "Cached input",
    usage_full_api_rate: "* if billed at full API rate",
    usage_no_quota: "No quota data (subscription OAuth providers only)",
    usage_no_token_usage: "No recorded token usage",
    usage_output: "Output",
    usage_period: "Last 30 days",
    usage_processed_tokens: "Processed tokens",
    usage_raw_token_cost: "RAW TOKEN COST",
    usage_subscription_quota: "Subscription quota",
    usage_uncached_input: "Uncached input",
    usage_used: "used",
    worktree: "Worktree",
  },
  zh: {
    add_local_dir: "添加本地目录",
    add_project: "添加项目",
    back: "返回",
    choose_project: "选择项目",
    choose_project_start: "选择一个项目开始",
    import_desc: "选择一个已有的 Pi 会话，将在此目录创建分支副本。",
    import_session: "导入会话",
    import_title: "导入会话到 {name}",
    language: "语言",
    load_older: "加载更早的消息",
    local: "本地",
    new_project: "新建项目…",
    new_session: "新会话",
    new_task: "新任务",
    no_branch: "无分支",
    no_changes: "无变更",
    no_project: "不使用项目",
    open_surface: "打开面板",
    open_surface_desc: "选择右侧面板显示的内容",
    projects: "项目",
    prompt_placeholder: "做些什么…（可粘贴图片、用 @ 选择文件、用 / 运行命令）",
    refresh: "刷新",
    search: "搜索",
    search_settings: "搜索设置…",
    section_appearance: "外观",
    section_general: "通用",
    section_packages: "扩展包",
    section_providers: "提供商",
    section_skills: "技能",
    section_usage: "用量",
    select_model: "选择模型",
    settings: "设置",
    surface_browser: "浏览器",
    surface_browser_desc: "打开本地应用或网址",
    surface_files: "文件",
    surface_files_desc: "浏览和读取工作区文件",
    surface_review: "变更",
    surface_review_desc: "查看文件变更",
    surface_terminal: "终端",
    surface_terminal_desc: "在当前工作区启动 shell",
    theme: "主题",
    theme_dark: "深色",
    theme_light: "浅色",
    theme_system: "跟随系统",
    tokens: "个 token",
    untitled: "未命名会话",
    usage_by_model: "按模型统计",
    usage_cache_savings: "缓存节省",
    usage_cached_input: "缓存输入",
    usage_full_api_rate: "* 按完整 API 费率估算",
    usage_no_quota: "暂无配额数据（仅支持订阅制 OAuth 提供商）",
    usage_no_token_usage: "暂无已记录的 Token 用量",
    usage_output: "输出",
    usage_period: "最近 30 天",
    usage_processed_tokens: "处理 Token",
    usage_raw_token_cost: "原始 Token 成本",
    usage_subscription_quota: "订阅配额",
    usage_uncached_input: "未缓存输入",
    usage_used: "已使用",
    worktree: "Worktree",
  },
} as const;

export type I18nKey = keyof (typeof dict)["en"];

interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: I18nKey, vars?: Record<string, string>) => string;
}

const I18nContext = createContext<I18nValue>({
  lang: "en",
  setLang: () => undefined,
  t: (key) => key,
});

const stored = localStorage.getItem("omo:lang");
const browserLang: Lang = navigator.language.toLowerCase().startsWith("zh")
  ? "zh"
  : "en";
const defaultLang: Lang =
  stored === "zh" || stored === "en" ? stored : browserLang;

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(defaultLang);
  useEffect(() => localStorage.setItem("omo:lang", lang), [lang]);
  const t = (key: I18nKey, vars?: Record<string, string>) => {
    let text: string = dict[lang][key] ?? dict.en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(`{${k}}`, v);
      }
    }
    return text;
  };
  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export const useI18n = () => useContext(I18nContext);
