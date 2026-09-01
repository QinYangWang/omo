import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "zh" | "en";

const dict = {
  en: {
    search: "Search",
    projects: "PROJECTS",
    add_project: "Add project",
    add_local_dir: "Add a local directory",
    new_session: "New session",
    import_session: "Import session",
    import_title: "Import session to {name}",
    import_desc: "Select an existing Pi session. A project-local fork will be created.",
    untitled: "Untitled session",
    settings: "Settings",
    back: "Back",
    search_settings: "Search settings…",
    new_task: "New task",
    choose_project: "Choose a project",
    choose_project_start: "Choose a project to start",
    new_project: "New project…",
    no_project: "Don't work in a project",
    prompt_placeholder: "Do anything…",
    load_older: "Load older messages",
    open_surface: "Open a surface",
    open_surface_desc: "Choose what to show in the right panel",
    surface_browser: "Browser",
    surface_browser_desc: "Open a local app or URL",
    surface_terminal: "Terminal",
    surface_terminal_desc: "Start a shell in this workspace",
    surface_files: "Files",
    surface_files_desc: "Browse and read workspace files",
    surface_review: "Review",
    surface_review_desc: "Review file changes",
    no_changes: "No changes",
    local: "Local",
    worktree: "Worktree",
    no_branch: "No branch",
    select_model: "Select model",
    section_general: "General",
    section_appearance: "Appearance",
    section_providers: "Providers",
    section_skills: "Skills",
    section_usage: "Usage",
    section_packages: "Packages",
    theme: "Theme",
    theme_dark: "Dark",
    theme_light: "Light",
    theme_system: "System",
    language: "Language",
  },
  zh: {
    search: "搜索",
    projects: "项目",
    add_project: "添加项目",
    add_local_dir: "添加本地目录",
    new_session: "新会话",
    import_session: "导入会话",
    import_title: "导入会话到 {name}",
    import_desc: "选择一个已有的 Pi 会话，将在此目录创建分支副本。",
    untitled: "未命名会话",
    settings: "设置",
    back: "返回",
    search_settings: "搜索设置…",
    new_task: "新任务",
    choose_project: "选择项目",
    choose_project_start: "选择一个项目开始",
    new_project: "新建项目…",
    no_project: "不使用项目",
    prompt_placeholder: "做些什么…",
    load_older: "加载更早的消息",
    open_surface: "打开面板",
    open_surface_desc: "选择右侧面板显示的内容",
    surface_browser: "浏览器",
    surface_browser_desc: "打开本地应用或网址",
    surface_terminal: "终端",
    surface_terminal_desc: "在当前工作区启动 shell",
    surface_files: "文件",
    surface_files_desc: "浏览和读取工作区文件",
    surface_review: "变更",
    surface_review_desc: "查看文件变更",
    no_changes: "无变更",
    local: "本地",
    worktree: "Worktree",
    no_branch: "无分支",
    select_model: "选择模型",
    section_general: "通用",
    section_appearance: "外观",
    section_providers: "提供商",
    section_skills: "技能",
    section_usage: "用量",
    section_packages: "扩展包",
    theme: "主题",
    theme_dark: "深色",
    theme_light: "浅色",
    theme_system: "跟随系统",
    language: "语言",
  },
} as const;

export type I18nKey = keyof (typeof dict)["en"];

const I18nContext = createContext<{ lang: Lang; t: (key: I18nKey, vars?: Record<string, string>) => string }>({
  lang: "en",
  t: (k) => k,
});

const stored = localStorage.getItem("omo:lang");
const defaultLang: Lang =
  stored === "zh" || stored === "en" ? stored : navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(defaultLang);
  useEffect(() => localStorage.setItem("omo:lang", lang), [lang]);
  const t = (key: I18nKey, vars?: Record<string, string>) => {
    let text: string = dict[lang][key] ?? dict.en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, v);
    return text;
  };
  return <I18nContext.Provider value={{ lang, t, setLang } as any}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext) as { lang: Lang; setLang: (l: Lang) => void; t: (k: I18nKey, v?: Record<string, string>) => string };
