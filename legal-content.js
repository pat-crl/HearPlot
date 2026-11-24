/*
  HearPlot — SHARED LEGAL CONTENT

  This small file is the single source for the legal wording shown inside the
  app. Run `npm run sync:legal` after changing it to recreate PRIVACY.md and
  TERMS.md, so the in-app copy and repository documents remain the same.
*/

// One value is reused by both documents, preventing their contact details drifting apart.
const SUPPORT_EMAIL = "info@pcarroll.au";

const musicAnalyserLegal = {
  appName: "HearPlot",
  version: "0.3.1",
  developer: "Pat Carroll",
  effectiveDate: "18 November 2026",
  copyright: "© 2026 Pat Carroll. All rights reserved.",
  supportEmail: SUPPORT_EMAIL,
  documents: {
    privacy: {
      title: "Privacy Policy",
      summary: "This policy explains how HearPlot handles information when you use it.",
      sections: [
        {
          heading: "Information the app handles",
          paragraphs: [
            "HearPlot handles an audio file only after you choose or drop it into the app. It may read the file's common embedded music metadata, including artist, track title, album name, and artwork. The app also handles your annotations, arrangement markers, categories, rhythm-grid corrections, and track details. If you select a reference recording in MixLab, the app also handles that recording and its measurements.",
            "To reopen a recent analysis in the desktop app, the app stores a local reference to the selected recording, including its path when Electron makes that available, file name, size, and last-modified time."
          ]
        },
        {
          heading: "How information is processed and stored",
          paragraphs: [
            "Audio decoding, waveform and spectrogram drawing, loudness and tempo analysis, beat-grid estimation, metronome playback, and annotation work happen on your device. The app does not include an account system, an app-operated upload service, cloud synchronisation, or a backend that receives recordings or notes.",
            "The app stores analysis data and preferences in your device's local browser storage. This can include annotations, arrangement markers, categories, artist and track metadata, compact artwork thumbnails, recent-analysis references, corrected rhythm-grid settings, an optional audio-download link that you provide, display and playback preferences, and MixLab measurements such as loudness, frequency balance and stereo characteristics. Saved MixLab sessions may include the reference name and measurements, while auditioning the reference again requires selecting its audio file. You can export an editable JSON session; it does not contain the audio recording itself. Clearing the app's stored data removes this locally saved app data, while exported files remain where you saved or shared them.",
            "When you choose to copy analysis text, it is placed on your system clipboard. When you choose the system sharing option, the exported JSON session is passed to the sharing destination you choose; that destination's privacy practices then apply."
          ]
        },
        {
          heading: "Network use and third-party services",
          paragraphs: [
            "The interface uses fonts installed on your device. Opening an optional audio link connects to its host in your browser, and sharing a file uses the destination you choose. HearPlot does not operate an analytics, advertising, crash-reporting or cloud service."
          ]
        },
        {
          heading: "Permissions",
          paragraphs: [
            "The app accesses a recording only after you select it. The desktop version can read the selected file's metadata and reopen a recent local recording reference. The current project does not declare or use camera, microphone, location, contacts, or photo-library access."
          ]
        },
        {
          heading: "Sharing, retention, and your choices",
          paragraphs: [
            "HearPlot does not sell your recordings or annotations. Your locally stored data remains on your device until you clear the app's stored data or remove the relevant local files. Please keep your own backups of important analyses and exported sessions."
          ]
        },
        {
          heading: "Children's privacy",
          paragraphs: [
            "HearPlot is not designed for children to provide personal information. The app does not include accounts or a direct collection process for personal information."
          ]
        },
        {
          heading: "Security",
          paragraphs: [
            "The app is designed to process recordings locally and uses Electron's isolated renderer configuration. No method of storage or transmission is completely secure, so please keep your device and exported files appropriately protected."
          ]
        },
        {
          heading: "Changes and contact",
          paragraphs: [
            `If this policy changes, the updated version will be posted with a new effective date. For privacy questions, contact ${SUPPORT_EMAIL}.`
          ]
        }
      ]
    },
    terms: {
      title: "Terms of Use",
      summary: "These terms set out the conditions for using HearPlot.",
      sections: [
        {
          heading: "Acceptance",
          paragraphs: [
            "By using HearPlot, you agree to these Terms of Use. If you do not agree, do not use the app."
          ]
        },
        {
          heading: "Licence",
          paragraphs: [
            "Pat Carroll grants you a limited, personal, non-exclusive, non-transferable, revocable licence to use HearPlot in accordance with these terms."
          ]
        },
        {
          heading: "Ownership",
          paragraphs: [
            "Pat Carroll owns the app and its original source code, branding, graphics, documentation, and other original material, subject to applicable third-party and open-source licences. © 2026 Pat Carroll. All rights reserved."
          ]
        },
        {
          heading: "Restrictions",
          paragraphs: [
            "To the extent permitted by law, you must not copy, modify, distribute, resell, rent, lease, commercially exploit, or reverse engineer the app except where applicable law permits it."
          ]
        },
        {
          heading: "Your content",
          paragraphs: [
            "You are responsible for the recordings, metadata, annotations, and other content you import, create, use, export, or share through the app. You must have the rights and permissions needed to process that content. You keep ownership of your content."
          ]
        },
        {
          heading: "Availability and backups",
          paragraphs: [
            "The app may not always be uninterrupted, secure, or error-free. To the extent permitted by law, Pat Carroll is not responsible for lost or damaged files, lost work, or indirect losses. Keep your own backups of recordings, annotations, and exported sessions."
          ]
        },
        {
          heading: "Third-party services",
          paragraphs: [
            "Google Fonts and any sharing destination you choose are separate services. Their own terms and privacy policies apply, and Pat Carroll is not responsible for those services."
          ]
        },
        {
          heading: "Liability and consumer rights",
          paragraphs: [
            "Nothing in these terms excludes, restricts, or modifies any consumer guarantee, right, or remedy that cannot lawfully be excluded, restricted, or modified under the Australian Consumer Law or other applicable law. Subject to that sentence, any liability is limited to the extent permitted by law."
          ]
        },
        {
          heading: "Termination and changes",
          paragraphs: [
            "This licence may end if you materially breach these terms. Updated terms will be posted with a new effective date, and your continued use after that date means you accept the updated terms."
          ]
        },
        {
          heading: "Governing law and contact",
          paragraphs: [
            `These terms are governed by the laws of New South Wales, Australia. For questions about these terms, contact ${SUPPORT_EMAIL}.`
          ]
        }
      ]
    }
  }
};

// Electron loads this file in a browser, while the small sync script loads it in Node.
if (typeof window !== "undefined") {
  window.MusicAnalyserLegal = musicAnalyserLegal;

  document.querySelectorAll("[data-app-version]").forEach((element) => {
    element.textContent = musicAnalyserLegal.version;
  });

  const dialog = document.querySelector("#legalDialog");
  const dialogTitle = document.querySelector("#legalDialogTitle");
  const dialogContent = document.querySelector("#legalDialogContent");
  const closeButton = document.querySelector("#legalDialogClose");

  // Build the dialog with text nodes instead of HTML strings, so legal text is displayed safely.
  function showLegalDocument(documentKey) {
    const documentDetails = musicAnalyserLegal.documents[documentKey];
    if (!documentDetails || !dialog || !dialogTitle || !dialogContent) return;

    dialogTitle.textContent = documentDetails.title;
    dialogContent.replaceChildren();

    const summary = document.createElement("p");
    summary.textContent = documentDetails.summary;
    dialogContent.append(summary);

    documentDetails.sections.forEach((section) => {
      const sectionElement = document.createElement("section");
      const heading = document.createElement("h3");
      heading.textContent = section.heading;
      sectionElement.append(heading);
      section.paragraphs.forEach((paragraphText) => {
        const paragraph = document.createElement("p");
        paragraph.textContent = paragraphText;
        sectionElement.append(paragraph);
      });
      dialogContent.append(sectionElement);
    });

    dialog.showModal();
    dialogContent.focus();
  }

  document.querySelectorAll("[data-legal-document]").forEach((button) => {
    button.addEventListener("click", () => showLegalDocument(button.dataset.legalDocument));
  });

  closeButton?.addEventListener("click", () => dialog?.close());
  dialog?.addEventListener("click", (event) => {
    // Clicking the shaded area outside the panel is an extra, familiar way to close it.
    if (event.target === dialog) dialog.close();
  });
}

if (typeof module !== "undefined") module.exports = musicAnalyserLegal;
