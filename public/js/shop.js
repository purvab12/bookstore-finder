import { api, boot, requireAuth, saveStaffPick, toast } from "./core.js";

await boot();

const id = decodeURIComponent(location.pathname.replace(/^\/shop\//, "").replace(/\/$/, ""));

const follow = document.querySelector("#follow-store");
if (follow) {
  follow.addEventListener("click", async () => {
    if (!requireAuth("Sign in to follow bookshops.")) return;
    const following = follow.dataset.following === "true";
    follow.disabled = true;
    try {
      await api(`/api/stores/${encodeURIComponent(id)}/favorite`, { method: following ? "DELETE" : "POST" });
      follow.dataset.following = String(!following);
      follow.textContent = following ? "Follow this shop" : "Following ✓";
      follow.classList.toggle("btn-following", !following);
      follow.classList.toggle("btn-primary", following);
      toast(following ? "Unfollowed" : "Following this shop");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      follow.disabled = false;
    }
  });
}

const claimToggle = document.querySelector("#claim-toggle");
const claimSection = document.querySelector("#claim-section");
if (claimToggle && claimSection) {
  claimToggle.addEventListener("click", () => {
    claimSection.hidden = !claimSection.hidden;
    if (!claimSection.hidden) claimSection.scrollIntoView({ behavior: "smooth", block: "end" });
  });
}

const claimForm = document.querySelector("#claim-form");
if (claimForm) {
  claimForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const result = await api(`/api/stores/${encodeURIComponent(id)}/claim`, { method: "POST", body: data });
      toast(result.message);
      form.reset();
      claimSection.hidden = true;
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });
}

for (const button of document.querySelectorAll("[data-save-pick]")) {
  button.addEventListener("click", () => saveStaffPick(button.dataset.savePick, button));
}
