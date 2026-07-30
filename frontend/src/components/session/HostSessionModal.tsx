import { useState } from "react";
import type { Session } from "@/types";
import { Button, Chip, Icon, Input, Modal } from "@/components/ui";
import { usePlacesInput } from "@/hooks/usePlacesInput";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/utils/cn";
import { createSession, geocodeAddress } from "@/api/sessionApi";

export interface HostSessionModalProps {
  open: boolean;
  onClose: () => void;
  groupId: number;
  /** Called with the created Session after a successful POST /api/sessions. */
  onCreated: (session: Session) => void;
}

// Occasion preset chips (from the Figma). A chip sets the occasion; the free-text
// field overrides so the host can type anything.
const OCCASION_PRESETS = ["Dinner", "Group lunch", "Date", "Coffee chat"];

// "Members answer within" preset durations — the combobox dropdown. The host can
// also type any custom duration (see parseMinutes); these are just quick picks.
const TIME_LIMIT_PRESETS = [
  { label: "5 minutes", value: 5 },
  { label: "15 minutes", value: 15 },
  { label: "30 minutes", value: 30 },
  { label: "1 hour", value: 60 },
];

// Parse a free-text duration into whole minutes (drives the expiry timer). Accepts
// the preset labels plus loose input: "1 hr"/"2 hours" → hours, "45 min"/"45m" →
// minutes, a bare number → minutes. Returns null when it can't read a positive
// duration, so the caller can block submit + show a hint.
function parseMinutes(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const hours = t.match(/^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)$/);
  if (hours) {
    const mins = Math.round(parseFloat(hours[1]) * 60);
    return mins > 0 ? mins : null;
  }
  const mins = t.match(/^(\d+)\s*(?:m|min|mins|minute|minutes)?$/);
  if (mins) {
    const n = parseInt(mins[1], 10);
    return n > 0 ? n : null;
  }
  return null;
}

// Hour options for the scheduled time dropdown (12h labels -> 24h value).
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => {
  const label =
    h === 0
      ? "12:00 AM"
      : h < 12
        ? `${h}:00 AM`
        : h === 12
          ? "12:00 PM"
          : `${h - 12}:00 PM`;
  return { value: h, label };
});

type GeoStatus = "idle" | "checking" | "ok" | "notfound";

// Today's date as yyyy-mm-dd for the <input type="date"> min + default.
function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// The host's pre-session setup: occasion, meeting location (geocode-validated),
// date/time (Now or scheduled), and the answer window. On submit it creates the
// session — the gateway geocodes + seeds the host's Qa row.
export function HostSessionModal({
  open,
  onClose,
  groupId,
  onCreated,
}: HostSessionModalProps) {
  // A full-height sheet on a phone, the centered dialog on desktop. This form is
  // the app's tallest — as a centered dialog at 844px it would run off screen.
  const isMobile = useIsMobile();
  const [occasion, setOccasion] = useState("");
  const location = usePlacesInput("");
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("idle");
  // Coordinates from a picked Places suggestion — sent straight through so the
  // gateway can skip re-geocoding and the pin matches what the host saw.
  const [selectedCoords, setSelectedCoords] = useState<{
    lat: number;
    lon: number;
  } | null>(null);
  // Whether the autocomplete dropdown is open (suppressed right after a pick/blur).
  const [showSuggestions, setShowSuggestions] = useState(false);

  const [timeMode, setTimeMode] = useState<"now" | "schedule">("now");
  const [date, setDate] = useState(todayIso());
  const [hour, setHour] = useState(19); // 7 PM default

  // Free-text answer window (combobox): defaults to the "15 minutes" preset but the
  // host can type any duration. `timeLimit` is the parsed whole-minute value, null
  // when the text doesn't read as a positive duration.
  const [timeLimitText, setTimeLimitText] = useState("15 minutes");
  const [timeLimitOpen, setTimeLimitOpen] = useState(false);
  const timeLimit = parseMinutes(timeLimitText);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedAddress = location.value.trim();

  // Validate + geocode the typed location. Blocks submit until it resolves.
  const validateLocation = async () => {
    if (!trimmedAddress) {
      setGeoStatus("idle");
      return;
    }
    setGeoStatus("checking");
    try {
      const res = await geocodeAddress(trimmedAddress);
      setGeoStatus(res.ok ? "ok" : "notfound");
    } catch {
      setGeoStatus("notfound");
    }
  };

  // Editing the address invalidates a prior geocode result + picked coords.
  const handleAddressChange = (value: string) => {
    location.setValue(value);
    setShowSuggestions(true);
    if (selectedCoords) setSelectedCoords(null);
    if (geoStatus !== "idle") setGeoStatus("idle");
  };

  // Pick a suggestion: resolve its address + coordinates (from the cached
  // autocomplete result — no extra request), confirm the field.
  const handleSelectSuggestion = (placeId: string) => {
    setShowSuggestions(false);
    const place = location.select(placeId);
    if (place) {
      setSelectedCoords({ lat: place.lat, lon: place.lon });
      setGeoStatus("ok");
    } else {
      setSelectedCoords(null);
      setGeoStatus("notfound");
    }
  };

  const canSubmit =
    Boolean(trimmedAddress) && geoStatus === "ok" && timeLimit !== null && !submitting;

  const buildScheduledFor = (): string | "now" => {
    if (timeMode === "now") return "now";
    // Compose local date + hour into an ISO instant.
    const dt = new Date(`${date}T00:00:00`);
    dt.setHours(hour, 0, 0, 0);
    return dt.toISOString();
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const session = await createSession({
        group_id: groupId,
        time_limit: timeLimit ?? 15,
        occasion: occasion.trim() || null,
        scheduled_for: buildScheduledFor(),
        location_address: trimmedAddress,
        // Coords from a picked Places suggestion (omitted when the host typed a
        // raw address — the gateway then geocodes server-side as before).
        location_lat: selectedCoords?.lat ?? null,
        location_lon: selectedCoords?.lon ?? null,
      });
      onCreated(session);
    } catch {
      setError("Could not start the session. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start a group session"
      // `lg` on desktop so the location field is wide enough to show its full
      // "Search a place, e.g. Salesforce Tower" placeholder without truncating.
      size="lg"
      variant={isMobile ? "sheet" : "center"}
      // Sticky footer so "Start session" stays reachable while the form scrolls.
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="accent"
            fullWidth={isMobile}
            leftIcon={<Icon name="sparkles" size={14} />}
            disabled={!canSubmit}
            isLoading={submitting}
            onClick={() => void handleSubmit()}
          >
            Start session
          </Button>
          <Button
            variant="ghost"
            fullWidth={isMobile}
            onClick={onClose}
            disabled={submitting}
            // Cancel reads first on desktop, but on a phone the primary action
            // belongs at the thumb — so reverse the order, not the markup.
            className="sm:order-first"
          >
            Cancel
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {/* Occasion */}
        <div className="flex flex-col gap-2">
          <label className="text-body font-medium text-text">
            What's the occasion?
          </label>
          <div className="flex flex-wrap gap-2">
            {OCCASION_PRESETS.map((preset) => (
              <Chip
                key={preset}
                label={preset}
                selected={occasion === preset}
                onToggle={() => setOccasion(occasion === preset ? "" : preset)}
              />
            ))}
          </div>
          <Input
            placeholder="Or type your own (e.g. Priya's birthday)"
            value={occasion}
            onChange={(e) => setOccasion(e.target.value)}
          />
        </div>

        {/* Location — geocode-validated */}
        <div className="flex flex-col gap-2">
          <label className="text-body font-medium text-text">
            Where should we meet?
          </label>
          <div className="flex items-start gap-2">
            <div className="relative flex-1">
              <Input
                leftIcon={<Icon name="map-pin" size={14} />}
                placeholder="Search a place, e.g. Salesforce Tower"
                value={location.value}
                onChange={(e) => handleAddressChange(e.target.value)}
                onBlur={() => {
                  // Delay so a suggestion click registers before we close/validate.
                  window.setTimeout(() => {
                    setShowSuggestions(false);
                    if (!selectedCoords) void validateLocation();
                  }, 150);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setShowSuggestions(false);
                }}
                error={
                  geoStatus === "notfound"
                    ? "Couldn't find that place — try another."
                    : undefined
                }
                hint={geoStatus === "ok" ? "✓ Location confirmed" : undefined}
              />
              {showSuggestions && location.suggestions.length > 0 && (
                <ul
                  className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-input border border-border bg-surface py-1 shadow-lg"
                  role="listbox"
                >
                  {location.suggestions.map((s) => (
                    <li key={s.placeId}>
                      <button
                        type="button"
                        // onMouseDown fires before the input's onBlur, so the pick
                        // isn't lost to the blur-close above.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          handleSelectSuggestion(s.placeId);
                        }}
                        className="flex w-full items-start gap-2 px-3 py-2 text-left text-body text-text hover:bg-surface-sunken"
                      >
                        <Icon
                          name="map-pin"
                          size={14}
                          className="mt-0.5 shrink-0 text-text-muted"
                        />
                        <span>{s.description}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Button
              variant="ghost"
              size="md"
              isLoading={geoStatus === "checking"}
              disabled={!trimmedAddress || geoStatus === "ok"}
              onClick={() => void validateLocation()}
            >
              {geoStatus === "ok" ? "Confirmed" : "Check"}
            </Button>
          </div>
        </div>

        {/* Date & time — Now / Schedule */}
        <div className="flex flex-col gap-2">
          <label className="text-body font-medium text-text">When?</label>
          <div className="flex gap-2">
            {(["now", "schedule"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setTimeMode(mode)}
                className={cn(
                  "flex-1 rounded-input border px-3 py-2 text-body font-medium transition-colors",
                  timeMode === mode
                    ? "border-surface-inverse bg-surface-inverse text-white"
                    : "border-border bg-surface-sunken text-text-muted hover:border-border-strong",
                )}
              >
                {mode === "now" ? "Now" : "Schedule"}
              </button>
            ))}
          </div>
          {timeMode === "schedule" && (
            // Stacked on a phone: two flex-1 siblings collide at 390px because
            // iOS renders the native date control at a fixed intrinsic width.
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="date"
                aria-label="Date"
                value={date}
                min={todayIso()}
                onChange={(e) => setDate(e.target.value)}
                className="h-11 w-full min-w-0 rounded-input border border-border bg-surface-sunken px-3 text-text focus:outline-none focus:ring-2 focus:ring-focus-ring sm:flex-1"
              />
              <select
                aria-label="Time"
                value={hour}
                onChange={(e) => setHour(Number(e.target.value))}
                className="h-11 w-full min-w-0 rounded-input border border-border bg-surface-sunken px-3 text-text focus:outline-none focus:ring-2 focus:ring-focus-ring sm:flex-1"
              >
                {HOUR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Answer window — an editable combobox: pick a preset from the dropdown
            (5 min / 15 min / 30 min / 1 hour) OR type any custom duration.
            parseMinutes reads whatever the host types. Built as an input + a
            custom menu (not a native <datalist>, which renders inconsistently and
            didn't open reliably here) mirroring the location autocomplete above. */}
        <div className="flex flex-col gap-2">
          <label
            htmlFor="answer-window"
            className="text-body font-medium text-text"
          >
            Members answer within
          </label>
          <div className="relative">
            <Input
              id="answer-window"
              role="combobox"
              aria-expanded={timeLimitOpen}
              aria-controls="answer-window-options"
              autoComplete="off"
              leftIcon={<Icon name="calendar" size={14} />}
              // pr-11 keeps the typed value clear of the inset chevron affordance.
              className="pr-11"
              placeholder="e.g. 15 minutes"
              value={timeLimitText}
              onChange={(e) => {
                setTimeLimitText(e.target.value);
                setTimeLimitOpen(true);
              }}
              onFocus={() => setTimeLimitOpen(true)}
              onBlur={() => {
                // Delay so a menu click registers before the blur closes it.
                window.setTimeout(() => setTimeLimitOpen(false), 150);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setTimeLimitOpen(false);
                if (e.key === "ArrowDown") setTimeLimitOpen(true);
              }}
              error={
                timeLimitText.trim() && timeLimit === null
                  ? "Enter a duration like “15 minutes” or “1 hour”."
                  : undefined
              }
            />
            {/* Dropdown chevron — the same affordance the native <select> Time
                control shows, so this reads as a dropdown. onMouseDown (not click)
                + preventDefault toggles the menu without stealing/blurring focus. */}
            <button
              type="button"
              tabIndex={-1}
              aria-label="Toggle duration options"
              onMouseDown={(e) => {
                e.preventDefault();
                setTimeLimitOpen((o) => !o);
              }}
              className={cn(
                "absolute right-3.5 top-[22px] -translate-y-1/2 text-text-muted transition-transform hover:text-text",
                timeLimitOpen && "rotate-180",
              )}
            >
              <Icon name="chevron-down" size={16} />
            </button>
            {timeLimitOpen && (
              <ul
                id="answer-window-options"
                role="listbox"
                className="absolute z-20 mt-1 w-full overflow-hidden rounded-input border border-border bg-surface py-1 shadow-lg"
              >
                {TIME_LIMIT_PRESETS.map((o) => (
                  <li key={o.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={timeLimit === o.value}
                      // onMouseDown fires before the input's onBlur, so the pick
                      // isn't lost to the blur-close above.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setTimeLimitText(o.label);
                        setTimeLimitOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-2 text-left text-body text-text hover:bg-surface-sunken",
                        timeLimit === o.value && "bg-surface-sunken",
                      )}
                    >
                      {o.label}
                      {timeLimit === o.value && (
                        <Icon
                          name="check"
                          size={14}
                          className="text-primary"
                        />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {error && <p className="text-body text-error">{error}</p>}
      </div>
    </Modal>
  );
}
