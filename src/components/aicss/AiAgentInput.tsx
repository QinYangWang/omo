import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import styles from "./AiAgentInput.module.css";

interface AiAgentInputProps extends Omit<ComponentProps<"form">, "children"> {
  children: ReactNode;
}

/**
 * AICSS AI Agent Input adapted as a controlled shadcn composition.
 * Product state and actions are supplied by the caller instead of the
 * registry demo's mock models, skills, attachments, and enhance request.
 */
function AiAgentInput({ children, className, ...props }: AiAgentInputProps) {
  return (
    <form className={cn("w-full", className)} {...props}>
      <InputGroup className={styles.frame}>{children}</InputGroup>
    </form>
  );
}

function AiAgentInputTextarea({
  className,
  ...props
}: ComponentProps<typeof InputGroupTextarea>) {
  return (
    <InputGroupTextarea className={cn(styles.textarea, className)} {...props} />
  );
}

function AiAgentInputHeader({
  className,
  ...props
}: Omit<ComponentProps<typeof InputGroupAddon>, "align">) {
  return (
    <InputGroupAddon
      align="block-start"
      className={cn(styles.header, className)}
      {...props}
    />
  );
}

function AiAgentInputFooter({
  className,
  ...props
}: Omit<ComponentProps<typeof InputGroupAddon>, "align">) {
  return (
    <InputGroupAddon
      align="block-end"
      className={cn(styles.footer, className)}
      {...props}
    />
  );
}

function AiAgentInputSelectTrigger({
  className,
  hideIcon = true,
  ...props
}: ComponentProps<typeof SelectTrigger>) {
  return (
    <SelectTrigger
      className={cn(styles.selectTrigger, className)}
      hideIcon={hideIcon}
      {...props}
    />
  );
}

function AiAgentInputCompletionMenu({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(styles.completionMenu, className)}
      data-slot="ai-agent-completion-menu"
      {...props}
    />
  );
}

interface AiAgentInputCompletionItemProps
  extends ComponentProps<typeof Button> {
  active?: boolean;
}

function AiAgentInputCompletionItem({
  active = false,
  className,
  variant = "ghost",
  ...props
}: AiAgentInputCompletionItemProps) {
  return (
    <Button
      className={cn(styles.completionItem, className)}
      data-active={active || undefined}
      variant={variant}
      {...props}
    />
  );
}

function AiAgentInputCompletionMeta({
  className,
  ...props
}: ComponentProps<"div">) {
  return <div className={cn(styles.completionMeta, className)} {...props} />;
}

interface AiAgentInputButtonProps extends ComponentProps<typeof Button> {
  active?: boolean;
}

function AiAgentInputButton({
  active = false,
  className,
  ...props
}: AiAgentInputButtonProps) {
  return (
    <Button
      className={cn(styles.iconButton, className)}
      data-active={active || undefined}
      size="icon-xs"
      variant="ghost"
      {...props}
    />
  );
}

export {
  AiAgentInput,
  AiAgentInputButton,
  AiAgentInputCompletionItem,
  AiAgentInputCompletionMenu,
  AiAgentInputCompletionMeta,
  AiAgentInputFooter,
  AiAgentInputHeader,
  AiAgentInputSelectTrigger,
  AiAgentInputTextarea,
};
