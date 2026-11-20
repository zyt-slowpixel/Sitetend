import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
const buttonVariants = cva("inline-flex items-center justify-center rounded-md text-sm font-medium", {
  variants: { variant: { default: "bg-primary text-primary-foreground hover:bg-primary/90", outline: "border border-input bg-background" }, size: { default: "h-10 px-4 py-2", lg: "h-11 rounded-md px-8" } },
  defaultVariants: { variant: "default", size: "default" },
});
export function Button({ className, variant, size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
