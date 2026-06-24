import * as React from "react";
import { cn } from "@/lib/utils";

type SidebarProps = React.HTMLAttributes<HTMLElement> & {
  open?: boolean;
};

const Sidebar = React.forwardRef<HTMLElement, SidebarProps>(({ className, open = true, ...props }, ref) => (
  <aside
    ref={ref}
    data-state={open ? "expanded" : "collapsed"}
    className={cn(
      "shrink-0 border-gray-200 bg-[#f8faf9] transition-[width,max-width,height] duration-150 dark:border-gray-800 dark:bg-[#111c19] lg:border-r",
      open
        ? "h-[58dvh] max-h-[58dvh] w-full overflow-y-auto p-2 md:p-4 lg:h-dvh lg:max-h-dvh lg:w-[400px] lg:max-w-[400px] lg:p-5"
        : "h-14 max-h-14 w-full overflow-hidden p-2 lg:h-dvh lg:max-h-dvh lg:w-14 lg:max-w-14",
      className
    )}
    {...props}
  />
));
Sidebar.displayName = "Sidebar";

const SidebarHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("space-y-3 md:space-y-4", className)} {...props} />
);
SidebarHeader.displayName = "SidebarHeader";

const SidebarContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("space-y-3 md:space-y-4", className)} {...props} />
);
SidebarContent.displayName = "SidebarContent";

const SidebarInset = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => <main ref={ref} className={cn("min-w-0 flex-1 overflow-hidden", className)} {...props} />
);
SidebarInset.displayName = "SidebarInset";

export { Sidebar, SidebarContent, SidebarHeader, SidebarInset };
