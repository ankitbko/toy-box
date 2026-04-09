import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { getSettings, updateSetting } from "@/lib/settings";
import { setAgentUrl } from "@/functions/config";

export function SidebarFooter() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentBaseUrl, setAgentBaseUrl] = useState("");

  useEffect(() => {
    if (settingsOpen) {
      const s = getSettings();
      setAgentBaseUrl(s.agentBaseUrl);
    }
  }, [settingsOpen]);

  const handleAgentUrlSave = () => {
    const trimmed = agentBaseUrl.trim();
    updateSetting("agentBaseUrl", trimmed);
    if (trimmed) {
      setAgentUrl({ data: { agentBaseUrl: trimmed } });
    }
  };

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <div className="px-3 pt-3 md:pb-3 border-t flex items-center justify-between">
        <div className="flex items-center gap-2">
          <DialogTrigger asChild>
            <button
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Settings"
            >
              <Settings className="h-4 w-4" />
            </button>
          </DialogTrigger>
          <Separator
            orientation="vertical"
            className="h-4! w-px! bg-muted-foreground/50! mx-1 translate-y-px"
          />
          <Link to="/" className="font-bold text-foreground hover:text-primary transition-colors">
            {import.meta.env.VITE_APP_TITLE}
          </Link>
        </div>
      </div>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="space-y-2">
            <label htmlFor="agent-base-url" className="text-sm font-medium text-foreground">
              Agent URL
            </label>
            <Input
              id="agent-base-url"
              type="url"
              placeholder="https://{account}.services.ai.azure.com/api/projects/{project}/agents/{agentName}"
              value={agentBaseUrl}
              onChange={(e) => setAgentBaseUrl(e.target.value)}
              onBlur={handleAgentUrlSave}
            />
            <p className="text-xs text-muted-foreground">
              The hosted agent base URL. Falls back to the AGENT_BASE_URL environment variable.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
