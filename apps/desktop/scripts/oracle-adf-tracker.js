const hideOverlay = () => {
          const style = document.createElement('style');
          style.textContent = [
            'x-pw-glass, x-pw-overlay, x-pw-toolbar, [data-testid="recorder-toolbar"] { display: none !important; }',
            // Kill scroll anchoring — contributes to ADF autoscroll, not user-visible.
            '* { overflow-anchor: none !important; }'
          ].join('\n');
          (document.head || document.documentElement).appendChild(style);
        };
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', hideOverlay);
        } else {
          hideOverlay();
        }

        // Focusin tripwire — save/restore scroll across focus changes to
        // suppress ADF's focus-into-view autoscroll. Tab key gets a 150ms
        // escape hatch so keyboard nav can still reveal off-screen elements.
        // Skips wheel/scrollbar (only fires on focus events).
        try {
          let lastTabAt = 0;
          window.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') lastTabAt = Date.now();
          }, { capture: true });

          document.addEventListener('focusin', () => {
            if (Date.now() - lastTabAt < 150) return;
            const savedY = window.scrollY;
            const savedX = window.scrollX;
            const restore = () => {
              if (window.scrollY !== savedY || window.scrollX !== savedX) {
                window.scrollTo(savedX, savedY);
              }
            };
            // Two rAFs cover same-tick + rAF-delayed scroll paths.
            requestAnimationFrame(() => {
              restore();
              requestAnimationFrame(restore);
            });
          }, { capture: true });
        } catch (_) {}

        // Scan for Oracle ADF required field markers and broadcast to recorder.
        // ADF marks required fields with: label class containing "required",
        // '**' or '*' prefix in label text, or aria-required on inputs.
        // Canonical normalizer — must mirror oracleFieldClassifier.js normalizeText()
        const __flowtraceNormalize = (s) => String(s || '').toLowerCase()
          .replace(/^\*{1,2}\s*/, '').replace(/[_]+/g, ' ').replace(/[:*]+/g, '').replace(/\s+/g, ' ').trim();

        // Resolve field name from an input element using all available ADF patterns
        const __flowtraceFieldName = (el) => {
          const id = (el.id || el.name || '').replace(/::content$/, '');
          // 1. label[for] — standard
          if (id) {
            const lbl = document.querySelector('label[for="' + id + '"], label[for="' + id + '::content"]');
            if (lbl) return __flowtraceNormalize(lbl.textContent);
          }
          // 2. aria-label / title on the input itself
          const aria = el.getAttribute('aria-label') || el.getAttribute('title');
          if (aria) return __flowtraceNormalize(aria);
          // 3. Nearby label in parent row first-cell
          const row = el.closest('tr');
          if (row) {
            const cell = row.querySelector('td:first-child');
            if (cell) {
              const lbl = cell.querySelector('label') || cell;
              const t = __flowtraceNormalize(lbl.textContent);
              if (t && t.length < 60) return t;
            }
          }
          // 4. Parent container label
          const container = el.closest('[class*="af_input"], [class*="AF"]');
          if (container) {
            const lbl = container.querySelector('label');
            if (lbl) return __flowtraceNormalize(lbl.textContent);
          }
          return '';
        };

        const scanRequiredFields = () => {
          try {
            const required = {};

            // Method 1: Labels with "required" CSS class
            document.querySelectorAll('label[class*="required"], label[class*="Required"]').forEach(lbl => {
              const t = __flowtraceNormalize(lbl.textContent);
              if (t) required[t] = true;
            });

            // Method 2: Labels starting with * or **
            document.querySelectorAll('label').forEach(lbl => {
              if (/^\*{1,2}\s/.test(lbl.textContent.trim())) {
                const t = __flowtraceNormalize(lbl.textContent);
                if (t) required[t] = true;
              }
            });

            // Method 3: Separate star span/div BEFORE or beside a label (not inside it)
            document.querySelectorAll('span, div').forEach(s => {
              if (!/^\*{1,2}$/.test(s.textContent.trim())) return;
              // Find the nearest label sibling or in parent container
              const parent = s.parentElement;
              if (!parent) return;
              const lbl = parent.querySelector('label') ||
                          (parent.nextElementSibling && parent.nextElementSibling.matches('label') ? parent.nextElementSibling : null);
              if (lbl && !lbl.contains(s)) {
                const t = __flowtraceNormalize(lbl.textContent);
                if (t) required[t] = true;
              }
            });

            // Method 4: aria-required or required attribute on inputs
            document.querySelectorAll('[aria-required="true"], [required]').forEach(el => {
              const t = __flowtraceFieldName(el);
              if (t) required[t] = true;
            });

            // Method 5: ADF wrapper-level required markers
            document.querySelectorAll('input, textarea, select').forEach(el => {
              const fieldName = __flowtraceFieldName(el);
              if (!fieldName || required[fieldName]) return;
              // Walk up to the nearest ADF field container
              const wrapper = el.closest('td, tr, .x1fn, .x2f0, [class*="af_input"], [class*="AF"]');
              if (!wrapper) return;
              // Check for required CSS class or icon (NOT AFRequiredIconAbsence — that means optional)
              const hasReqClass = wrapper.querySelector(
                '[class*="required"]:not([class*="Absence"]), [class*="Required"]:not([class*="Absence"]), .AFRequiredIcon:not(.AFRequiredIconAbsence)'
              );
              if (hasReqClass) {
                required[fieldName] = true;
              }
            });

            if (Object.keys(required).length > 0) {
              console.log('__flowtrace_REQUIRED__:' + JSON.stringify(required));
            }
          } catch (_) {}
        };

        // Scan on page load, after ADF AJAX navigation, and on relevant DOM events
        scanRequiredFields();
        const _reqInterval = setInterval(scanRequiredFields, 2000);
        setTimeout(() => clearInterval(_reqInterval), 120000);


        // Capture cell context when user clicks a table cell in any ADF popup/dialog.
        // Playwright codegen often records partial ARIA names or .nth(N) selectors for
        // cells that appear multiple times. We capture the full row text so post-processing
        // can replace fragile .nth(N) with row-based selectors.
        // Works for: LOV popups, Distribution dialogs, Search-and-Select, any __af_Z_window.
        document.addEventListener('click', (e) => {
          try {
            const td = e.target.closest('td[role="gridcell"], td[role="cell"], td');
            if (!td) return;
            // Check if this td is inside any ADF popup/dialog
            const popup = td.closest('[id*="lovItems"], [id*="lov"], [id="__af_Z_window"], [id*="::dropDialog"], [id*="istribution"], [id*="Popup"], [id*="popup"]');
            if (!popup) return;
            const row = td.closest('tr');
            if (!row) return;
            // Capture text from each cell in the row
            const cells = [...row.querySelectorAll('td')].map(c => c.textContent.trim()).filter(Boolean);
            const fullRowText = cells.join(' ');
            const cellText = td.textContent.trim();
            // Count how many cells with the same text exist before this one (the nth index)
            const allMatchingCells = [...popup.querySelectorAll('td[role="gridcell"], td[role="cell"], td')].filter(c => c.textContent.trim() === cellText);
            const nthIndex = allMatchingCells.indexOf(td);
            if (cellText) {
              console.log('__flowtrace_LOV_CELL__:' + JSON.stringify({ cell: cellText, row: fullRowText, cells: cells, nthIndex: nthIndex }));
            }
          } catch (_) {}
        }, true);

        // Track date picker month navigation offset for full date calculation.
        // Oracle ADF date pickers use left/right arrows to change month; we track
        // the cumulative offset so we can reconstruct the full date from just the day number.
        let __flowtrace_dateMonthOffset = 0;
        document.addEventListener('click', (e) => {
          try {
            const btn = e.target.closest('a, button, span');
            if (!btn) return;
            const calendarPopup = btn.closest('.af_inputDate_picker, .af_chooseDate, [id*="::pop"], [id*="::cd"], [id*="dateEditor"], [id*="calendar"], .xnd, [class*="chooseDate"]');
            if (!calendarPopup) return;
            const title = btn.getAttribute('title') || btn.getAttribute('aria-label') || btn.textContent.trim() || '';
            // Also check the accessible name from getByRole perspective
            const ariaName = btn.getAttribute('name') || '';
            const combined = title + ' ' + ariaName;
            if (/prev|back|left|←|Previous/i.test(combined) || btn.classList.contains('af_chooseDate_prev') ||
                btn.closest('[class*="prev"]') || btn.closest('[class*="Prev"]')) {
              __flowtrace_dateMonthOffset--;
              console.log('__flowtrace_DATE_NAV__:' + JSON.stringify({ direction: 'prev', offset: __flowtrace_dateMonthOffset }));
            } else if (/next|forward|right|→|Next/i.test(combined) || btn.classList.contains('af_chooseDate_next') ||
                       btn.closest('[class*="next"]') || btn.closest('[class*="Next"]')) {
              __flowtrace_dateMonthOffset++;
              console.log('__flowtrace_DATE_NAV__:' + JSON.stringify({ direction: 'next', offset: __flowtrace_dateMonthOffset }));
            }
          } catch (_) {}
        }, true);

        // Capture date picker day clicks with full date context.
        // ADF date picker: gridcell with just a day number (1-31) inside a calendar popup.
        // We read the month/year header and combine with clicked day to get the full date.
        document.addEventListener('click', (e) => {
          try {
            const td = e.target.closest('td[role="gridcell"], td');
            if (!td) return;
            const dayText = td.textContent.trim();
            if (!/^\d{1,2}$/.test(dayText)) return;
            const day = parseInt(dayText, 10);
            if (day < 1 || day > 31) return;
            const calPopup = td.closest('.af_inputDate_picker, .af_chooseDate, [id*="::pop"], [id*="::cd"], [id*="dateEditor"], [id*="calendar"], .xnd');
            if (!calPopup) return;
            // NOT inside a LOV/data table — calendar rows have exactly 7 day cells
            const row = td.closest('tr');
            if (row) {
              const dataCells = [...row.querySelectorAll('td')].filter(c => c.textContent.trim().length > 0);
              if (dataCells.length > 0 && dataCells.length !== 7) return;
              const hasNonNumericSibling = dataCells.some(c => {
                const t = c.textContent.trim();
                return t && !/^\d{1,2}$/.test(t);
              });
              if (hasNonNumericSibling) return;
            }
            let month = null, year = null;
            const monthNames = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
                                  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
            const dateLabelCandidates = [
              td.getAttribute('aria-label'),
              td.getAttribute('title'),
              td.getAttribute('data-date'),
              td.getAttribute('abbr'),
              calPopup.getAttribute('aria-label'),
              calPopup.getAttribute('title'),
              ...[...td.querySelectorAll('[aria-label], [title]')].flatMap((node) => [
                node.getAttribute('aria-label'),
                node.getAttribute('title')
              ])
            ].filter(Boolean);
            for (const rawLabel of dateLabelCandidates) {
              const label = rawLabel.trim();
              const namedMatch = label.match(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})/i);
              if (namedMatch && parseInt(namedMatch[2], 10) === day) {
                month = monthNames[namedMatch[1].toLowerCase()];
                year = parseInt(namedMatch[3], 10);
                break;
              }
              const numericMatch = label.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
              if (numericMatch && parseInt(numericMatch[2], 10) === day) {
                month = parseInt(numericMatch[1], 10);
                year = parseInt(numericMatch[3], 10);
                if (year < 100) year += 2000;
                break;
              }
            }
            const headerSelectors = [
              '.af_chooseDate_title', '.af_inputDate_title', '[class*="calendar-title"]',
              '[class*="calendarHeader"]', '.xnd table caption', 'caption',
              '[class*="month-year"]', '[class*="header"] span',
              // ADF calendar uses a span/div between prev/next buttons for month-year
              'th[colspan]', '.x11d', '.x11e', 'table span[id]'
            ];
            for (const sel of headerSelectors) {
              if (month && year) break;
              const el = calPopup.querySelector(sel);
              if (el) {
                const headerText = el.textContent.trim();
                const dateMatch = headerText.match(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i);
                if (dateMatch) {
                  month = monthNames[dateMatch[1].toLowerCase()];
                  year = parseInt(dateMatch[2], 10);
                  break;
                }
              }
            }
            if (!month || !year) {
              const now = new Date();
              const adjusted = new Date(now.getFullYear(), now.getMonth() + __flowtrace_dateMonthOffset, 1);
              month = adjusted.getMonth() + 1;
              year = adjusted.getFullYear();
            }
            const shortYear = year % 100;
            const fullDate = month + '/' + day + '/' + shortYear;
            // Bind to target field identity — find the date input this calendar belongs to
            let targetFieldId = '';
            try {
              // ADF: popup ID ends with ::pop, input ID ends with ::content
              const popupId = calPopup.id || '';
              if (popupId.includes('::')) {
                const baseId = popupId.replace(/::(?:pop|cd|dlg)$/, '');
                const dateInput = document.getElementById(baseId + '::content');
                if (dateInput) targetFieldId = dateInput.id;
              }
              // Fallback: find nearest visible date input
              if (!targetFieldId) {
                const nearestInput = document.querySelector('input[id$="::content"][role="combobox"]:focus, input.af_inputDate_content:focus');
                if (nearestInput) targetFieldId = nearestInput.id;
              }
            } catch (_) {}
            console.log('__flowtrace_DATE_CELL__:' + JSON.stringify({
              day: day, month: month, year: year, fullDate: fullDate,
              monthOffset: __flowtrace_dateMonthOffset,
              targetFieldId: targetFieldId || ''
            }));
            // After the calendar day click, ADF commits the value to the bound input.
            // Poll the input field to capture the ACTUAL committed value (the real truth).
            // Try multiple times with increasing delays — ADF may take time to commit.
            [500, 1000, 1500].forEach(delay => {
              setTimeout(() => {
                try {
                  let dateInput = null;
                  let resolvedId = targetFieldId;
                  // Strategy 1: direct ID lookup
                  if (resolvedId) {
                    dateInput = document.getElementById(resolvedId);
                  }
                  // Strategy 2: find by popup-to-input ID mapping
                  if (!dateInput && calPopup && calPopup.id) {
                    const baseId = calPopup.id.replace(/::(?:pop|cd|dlg|cal).*$/, '');
                    const candidates = [
                      document.getElementById(baseId + '::content'),
                      document.getElementById(baseId + '::input'),
                      document.querySelector('input[id^="' + baseId + '"]')
                    ];
                    dateInput = candidates.find(el => el && el.value);
                    if (dateInput) resolvedId = dateInput.id;
                  }
                  // Strategy 3: find the most recently changed visible date input
                  if (!dateInput) {
                    const allDateInputs = document.querySelectorAll(
                      'input[id$="::content"]:not([type="hidden"]), input.af_inputDate_content, input[aria-label*="Date"], input[aria-label*="date"]'
                    );
                    for (const inp of allDateInputs) {
                      if (inp.value && /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(inp.value)) {
                        dateInput = inp;
                        resolvedId = inp.id || '';
                        break;
                      }
                    }
                  }
                  if (dateInput && dateInput.value) {
                    const val = dateInput.value.trim();
                    if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(val)) {
                      console.log('__flowtrace_DATE_INPUT_VALUE__:' + JSON.stringify({
                        targetFieldId: resolvedId || '',
                        inputValue: val
                      }));
                    }
                  }
                } catch (_) {}
              }, delay);
            });
            __flowtrace_dateMonthOffset = 0;
          } catch (_) {}
        }, true);

        // Capture select value→label AND field name when user picks from a <select>.
        document.addEventListener('change', (e) => {
          const el = e.target;
          if (el.tagName === 'SELECT' && el.selectedIndex >= 0) {
            const opt = el.options[el.selectedIndex];
            if (opt) {
              // Find the associated label for this select
              let fieldName = '';
              const id = el.id || el.name;
              if (id) {
                const lbl = document.querySelector('label[for="' + id + '"]') ||
                            document.querySelector('label[for="' + id.replace('::content', '') + '"]');
                if (lbl) fieldName = lbl.textContent.replace(/^\**\s*/, '').trim();
              }
              // Fallback: check parent row for a label-like cell
              if (!fieldName) {
                const row = el.closest('tr');
                if (row) {
                  const labelCell = row.querySelector('td:first-child');
                  if (labelCell) fieldName = labelCell.textContent.trim();
                }
              }
              console.log('__flowtrace_SELECT__:' + JSON.stringify({
                value: opt.value, label: opt.text.trim(),
                fieldName: fieldName, name: el.name || '', id: el.id || ''
              }));
            }
          }
        }, true);

        // Capture combobox input value during typing (input event).
        document.addEventListener('input', (e) => {
          try {
            const el = e.target;
            if (el.tagName !== 'INPUT' || el.type === 'hidden') return;
            const role = el.getAttribute('role');
            if (role !== 'combobox') return;
            const val = el.value.trim();
            if (!val) return;
            let fieldName = '';
            const id = el.id || el.name;
            if (id) {
              const lbl = document.querySelector('label[for="' + id + '"]') ||
                          document.querySelector('label[for="' + id.replace('::content', '') + '"]');
              if (lbl) fieldName = lbl.textContent.replace(/^\**\s*/, '').trim();
            }
            if (!fieldName) {
              const row = el.closest('tr');
              if (row) {
                const labelCell = row.querySelector('td:first-child');
                if (labelCell) fieldName = labelCell.textContent.trim();
              }
            }
            console.log('__flowtrace_COMBOBOX_VALUE__:' + JSON.stringify({
              fieldName: fieldName, value: val, id: el.id || '', name: el.name || ''
            }));
          } catch (_) {}
        }, true);

        // Capture committed field value AFTER ADF validates/commits (change event).
        // The 'change' event fires after the field loses focus and ADF has committed
        // the final value — this is the canonical value, not the partial search text.
        document.addEventListener('change', (e) => {
          try {
            const el = e.target;
            if (el.tagName !== 'INPUT' && el.tagName !== 'SELECT') return;
            const val = (el.value || '').trim();
            if (!val) return;
            const role = el.getAttribute('role');
            if (role !== 'combobox' && el.tagName !== 'SELECT') return;
            let fieldName = '';
            const id = (el.id || el.name || '').replace(/::content$/, '');
            if (id) {
              const lbl = document.querySelector('label[for="' + id + '"], label[for="' + id + '::content"]');
              if (lbl) fieldName = lbl.textContent.replace(/^\**\s*/, '').trim();
            }
            if (!fieldName) {
              const row = el.closest('tr');
              if (row) {
                const labelCell = row.querySelector('td:first-child');
                if (labelCell) fieldName = labelCell.textContent.trim();
              }
            }
            if (fieldName) {
              console.log('__flowtrace_COMMITTED_VALUE__:' + JSON.stringify({
                fieldName: fieldName, value: val, source: 'change-event'
              }));
            }
          } catch (_) {}
        }, true);

        // Checkbox click capture. ADF custom checkboxes get recorded by
        // codegen as generic getByText(label).click() — opaque to the
        // parameterizer. We detect the click touched a checkbox, resolve
        // its label and the post-toggle state, and emit metadata so
        // post-processing can rewrite to .check()/.uncheck().
        document.addEventListener('click', (e) => {
          try {
            const target = e.target;
            if (!target || !target.closest) return;

            // Try 7 detection paths: native input → ARIA role → label[for]
            // (own/ancestor) → role=checkbox ancestor → ADF wrapper class →
            // single-checkbox row.
            let checkbox = null;
            let labelText = '';

            if (target.tagName === 'INPUT' && target.type === 'checkbox') {
              checkbox = target;
            } else if (target.getAttribute && target.getAttribute('role') === 'checkbox') {
              checkbox = target;
            } else if (target.tagName === 'LABEL' && target.htmlFor) {
              const ref = document.getElementById(target.htmlFor);
              if (ref && ((ref.tagName === 'INPUT' && ref.type === 'checkbox')
                          || (ref.getAttribute && ref.getAttribute('role') === 'checkbox'))) {
                checkbox = ref;
                labelText = (target.textContent || '').trim();
              }
            }
            if (!checkbox) {
              const lblAnc = target.closest('label[for]');
              if (lblAnc && lblAnc.htmlFor) {
                const ref = document.getElementById(lblAnc.htmlFor);
                if (ref && ((ref.tagName === 'INPUT' && ref.type === 'checkbox')
                            || (ref.getAttribute && ref.getAttribute('role') === 'checkbox'))) {
                  checkbox = ref;
                  labelText = (lblAnc.textContent || '').trim();
                }
              }
            }
            if (!checkbox) {
              const cbAnc = target.closest('[role="checkbox"]');
              if (cbAnc) checkbox = cbAnc;
            }
            if (!checkbox) {
              const wrap = target.closest('.af_selectBooleanCheckbox, [class*="Checkbox"], [class*="checkbox"], [class*="Boolean"], [class*="boolean"]');
              if (wrap) {
                const innerCb = wrap.querySelector('input[type="checkbox"], [role="checkbox"]');
                if (innerCb) {
                  checkbox = innerCb;
                  labelText = (target.textContent || '').trim();
                }
              }
            }
            // Last path: ADF address-purpose layout (checkbox + label in
            // separate <td> cells). Match only when row has exactly 1 checkbox.
            if (!checkbox) {
              const row = target.closest('tr');
              if (row) {
                const cbs = row.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
                if (cbs.length === 1) {
                  checkbox = cbs[0];
                  labelText = (target.textContent || '').trim();
                }
              }
            }

            if (!checkbox) return;

            // Resolve label if not already known
            if (!labelText) {
              labelText = checkbox.getAttribute('aria-label') || '';
              if (!labelText) {
                const lblBy = checkbox.getAttribute('aria-labelledby');
                if (lblBy) {
                  const lbl = document.getElementById(lblBy);
                  if (lbl) labelText = (lbl.textContent || '').trim();
                }
              }
              if (!labelText && checkbox.id) {
                const lbl = document.querySelector('label[for="' + checkbox.id + '"]');
                if (lbl) labelText = (lbl.textContent || '').trim();
              }
              if (!labelText) {
                const wrapping = checkbox.closest('label');
                if (wrapping) labelText = (wrapping.textContent || '').trim();
              }
              if (!labelText) labelText = checkbox.getAttribute('title') || '';
            }

            // Invert before-state (sync) — reading post-PPR is unreliable
            // because ADF can re-render the element under us.
            const beforeChecked = checkbox.tagName === 'INPUT'
              ? !!checkbox.checked
              : checkbox.getAttribute('aria-checked') === 'true';
            const newChecked = !beforeChecked;
            const cleanLabel = labelText.replace(/^\**\s*/, '').replace(/[*:]+$/, '').replace(/\s+/g, ' ').trim();
            if (!cleanLabel) return;

            // Debounce 500ms vs the change-event listener below.
            if (!window.__flowtraceLastCbEmit) window.__flowtraceLastCbEmit = new WeakMap();
            const lastAt = window.__flowtraceLastCbEmit.get(checkbox);
            if (lastAt && Date.now() - lastAt < 500) return;
            window.__flowtraceLastCbEmit.set(checkbox, Date.now());

            console.log('__flowtrace_CHECKBOX__:' + JSON.stringify({
              label: cleanLabel,
              newChecked: newChecked,
              checkboxId: checkbox.id || '',
              tagName: checkbox.tagName,
              source: 'click'
            }));
          } catch (_) {}
        }, true);

        // Backup change-event listener — catches keyboard space-bar toggles
        // and any ADF markup the click-paths above didn't recognize.
        document.addEventListener('change', (e) => {
          try {
            const cb = e.target;
            if (!cb || cb.tagName !== 'INPUT' || cb.type !== 'checkbox') return;
            if (!window.__flowtraceLastCbEmit) window.__flowtraceLastCbEmit = new WeakMap();
            const lastAt = window.__flowtraceLastCbEmit.get(cb);
            if (lastAt && Date.now() - lastAt < 500) return;
            window.__flowtraceLastCbEmit.set(cb, Date.now());

            let labelText = cb.getAttribute('aria-label') || '';
            if (!labelText) {
              const lblBy = cb.getAttribute('aria-labelledby');
              if (lblBy) {
                const lbl = document.getElementById(lblBy);
                if (lbl) labelText = (lbl.textContent || '').trim();
              }
            }
            if (!labelText && cb.id) {
              const lbl = document.querySelector('label[for="' + cb.id + '"]');
              if (lbl) labelText = (lbl.textContent || '').trim();
            }
            if (!labelText) {
              const wrapping = cb.closest('label');
              if (wrapping) labelText = (wrapping.textContent || '').trim();
            }
            if (!labelText) {
              // Row-based fallback: nearest non-checkbox cell text in the row.
              const row = cb.closest('tr');
              if (row) {
                const cells = row.querySelectorAll('td, th');
                for (const c of cells) {
                  if (c.contains(cb)) continue;
                  const t = (c.textContent || '').trim();
                  if (t && t.length < 60) { labelText = t; break; }
                }
              }
            }
            const cleanLabel = labelText.replace(/^\**\s*/, '').replace(/[*:]+$/, '').replace(/\s+/g, ' ').trim();
            if (!cleanLabel) return;

            console.log('__flowtrace_CHECKBOX__:' + JSON.stringify({
              label: cleanLabel,
              newChecked: !!cb.checked,
              checkboxId: cb.id || '',
              tagName: 'INPUT',
              source: 'change'
            }));
          } catch (_) {}
        }, true);

        // After OK button click in any dialog, wait for ADF to commit then read
        // ALL visible field values. This is the generalized canonical-value capture:
        // covers LOV search-and-select, distribution, and any other dialog-driven field.
        document.addEventListener('click', (e) => {
          try {
            const btn = e.target.closest('button, a[role="button"], span[role="button"]');
            if (!btn) return;
            const btnText = (btn.textContent || '').trim();
            if (!/^(OK|Ok)$/i.test(btnText)) return;
            const dialog = btn.closest('[id="__af_Z_window"], div[id*="::dropDialog"], div[id*="::lovDialog"], [id*="Popup"], [id*="popup"]');
            if (!dialog) return;
            // Wait for ADF to commit the dialog selection back to the form
            setTimeout(() => {
              try {
                // ── Simple-LOV family path (existing) ──
                // Only LOV target inputs qualify: role=combobox + sibling "Search:" icon/link.
                // This avoids picking up unrelated inputs (pagination counters, filter boxes,
                // hidden numeric fields) that happen to be visible after OK.
                document.querySelectorAll('input[role="combobox"]:not([type="hidden"])').forEach(el => {
                  const val = (el.value || '').trim();
                  if (!val) return;
                  if (el.offsetParent === null && !el.closest('[style*="display"]')) return;
                  const id = (el.id || '').replace(/::content$/, '');
                  if (!id) return;
                  const lbl = document.querySelector('label[for="' + id + '"], label[for="' + id + '::content"]');
                  if (!lbl) return;
                  const fieldName = lbl.textContent.replace(/^\**\s*/, '').trim();
                  if (!fieldName) return;
                  // Require a Search/Select opener tied to the same field name — this is what
                  // makes it an LOV target and prevents capturing unrelated combobox values.
                  const hasOpener = !!document.querySelector(
                    'a[title^="Search: ' + fieldName + '"], a[title^="Select: ' + fieldName + '"], ' +
                    'img[title^="Search: ' + fieldName + '"], img[title^="Select: ' + fieldName + '"]'
                  );
                  if (!hasOpener) return;
                  console.log('__flowtrace_COMMITTED_VALUE__:' + JSON.stringify({
                    fieldName: fieldName, value: val, source: 'post-ok-scan'
                  }));
                });

                // ── Composite-picker family path (DOM-proximity binding) ──
                // When the user opened a Search:/Select: dialog, a sibling click
                // listener recorded { openerTitle, targetInputId } by walking up
                // from the opener element to its field container and grabbing
                // the associated input. On OK, read the input value DIRECTLY by
                // id — bypasses label-text matching, works even when the opener
                // text ("Select: Distribution") differs from the field label
                // ("Distribution Combination"). Works for any composite picker,
                // flexfield, or segment-driven dialog without per-field code.
                const bindings = window.__flowtraceOpenerBindings || [];
                for (const b of bindings) {
                  if (b.consumed) continue;
                  const input = document.getElementById(b.targetInputId);
                  if (!input) continue;
                  const val = (input.value || '').trim();
                  if (!val) continue;
                  // Derive a label for parameterizer readability — prefer
                  // the label[for] association, fall back to opener text.
                  let fieldName = '';
                  const bareId = (b.targetInputId || '').replace(/::content$/, '');
                  const lbl = document.querySelector('label[for="' + b.targetInputId + '"], label[for="' + bareId + '"]');
                  if (lbl) fieldName = lbl.textContent.replace(/^\**\s*/, '').trim();
                  if (!fieldName) {
                    fieldName = (b.openerTitle || '').replace(/^(?:Search|Select):\s*/i, '').trim();
                  }
                  if (!fieldName) continue;
                  console.log('__flowtrace_COMMITTED_VALUE__:' + JSON.stringify({
                    fieldName: fieldName,
                    value: val,
                    source: 'post-ok-binding',
                    openerTitle: b.openerTitle || ''
                  }));
                  b.consumed = true;
                }
              } catch (_) {}
            }, 1000);
          } catch (_) {}
        }, true);

        // Post-dblclick canonical-value scan. When a user double-clicks a row in an
        // Oracle Search-and-Select dialog, the dialog closes and the target combobox
        // gets the canonical committed value (e.g. "ADF International, Inc."), even
        // if the dblclick target text was a different column like an account number
        // ("R1014997"). The post-OK scan doesn't trigger (no OK button was clicked),
        // and ADF often sets the combobox value programmatically without firing a
        // change event. This listener fires the same scan as post-OK whenever a
        // dblclick lands inside a dialog/popup container.
        document.addEventListener('dblclick', (e) => {
          try {
            const dialog = e.target.closest('[id="__af_Z_window"], div[id*="::dropDialog"], div[id*="::lovDialog"], [id*="Popup"], [id*="popup"]');
            if (!dialog) return;
            setTimeout(() => {
              try {
                document.querySelectorAll('input[role="combobox"]:not([type="hidden"])').forEach(el => {
                  const val = (el.value || '').trim();
                  if (!val) return;
                  if (el.offsetParent === null && !el.closest('[style*="display"]')) return;
                  const id = (el.id || '').replace(/::content$/, '');
                  if (!id) return;
                  const lbl = document.querySelector('label[for="' + id + '"], label[for="' + id + '::content"]');
                  if (!lbl) return;
                  const fieldName = lbl.textContent.replace(/^\**\s*/, '').trim();
                  if (!fieldName) return;
                  const hasOpener = !!document.querySelector(
                    'a[title^="Search: ' + fieldName + '"], a[title^="Select: ' + fieldName + '"], ' +
                    'img[title^="Search: ' + fieldName + '"], img[title^="Select: ' + fieldName + '"]'
                  );
                  if (!hasOpener) return;
                  console.log('__flowtrace_COMMITTED_VALUE__:' + JSON.stringify({
                    fieldName: fieldName, value: val, source: 'post-dblclick-scan'
                  }));
                });
              } catch (_) {}
            }, 1200);
          } catch (_) {}
        }, true);

        // Composite-picker family — opener→target-input binding.
        // On any Search:/Select: opener click, walk up to the field container
        // (tr, panelFormLayout row, field container) and locate the associated
        // input element. Record a binding {openerTitle, targetInputId} that the
        // post-OK scan consumes to read the canonical committed value directly
        // from the input by id — bypassing label-text matching.
        //
        // Why this scales: the binding is DOM-proximity based. Works for any
        // Oracle flex/composite picker where an opener and its target input live
        // in the same row/container. No field-name aliases, no per-script code.
        // Safe for simple LOVs too — binding runs alongside existing exact-match
        // flow, doesn't replace it, and both target the same value.
        if (!window.__flowtraceOpenerBindings) window.__flowtraceOpenerBindings = [];
        document.addEventListener('click', (e) => {
          try {
            // Playwright's getByRole('link', { name: 'Select: X' }) matches by
            // accessible name computed from title > aria-label > text content,
            // or a child <img alt="..."> / aria-labelledby reference. A narrow
            // `a[title^="..."]` filter misses the other sources. Walk up any
            // clickable ancestor and derive the name the same way Playwright
            // would — title, aria-label, then inner text — and accept the
            // element if its derived name starts with "Search: " or "Select: ".
            const candidate = e.target.closest('a, button, img, [role="link"], [role="button"]');
            if (!candidate) return;
            const childImg = candidate.tagName === 'IMG' ? candidate : candidate.querySelector('img[alt]');
            const title = candidate.getAttribute('title') || '';
            const aria = candidate.getAttribute('aria-label') || '';
            const imgAlt = childImg ? (childImg.getAttribute('title') || childImg.getAttribute('alt') || '') : '';
            const text = (candidate.textContent || '').replace(/\s+/g, ' ').trim();
            const derivedName = (title || aria || imgAlt || text).replace(/\s+/g, ' ').trim();
            if (!/^(Search|Select):\s+\S/.test(derivedName)) return;
            const openerTitle = derivedName;

            // Walk up containers looking for an input. Start at the TIGHTEST
            // container (td, then ADF field/input wrappers), widen to tr last.
            // Starting narrow ensures that on line-item rows with many inputs
            // (Number, Amount, Distribution Combination, Accounting Date), we
            // pick the input in the SAME cell as the opener — not the first
            // input in the whole row.
            const CONTAINER_SEL =
              'td, ' +                                      // tightest cell
              '[class*="af_panelLabelAndMessage"], ' +      // ADF label+input wrapper
              '[class*="af_inputListOf"], ' +               // ADF LOV wrapper
              '[class*="fieldContainer"], ' +
              '[class*="inputContainer"], ' +
              '[class*="af_panelFormLayout"], ' +
              '[class*="panelFormLayout"], ' +
              'tr';                                          // widest, last resort
            let node = candidate.closest(CONTAINER_SEL);
            let targetInput = null;
            let hops = 0;
            while (node && hops < 6) {
              targetInput = node.querySelector(
                'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"])'
              );
              if (targetInput && targetInput.id) break;
              targetInput = null;
              node = node.parentElement ? node.parentElement.closest(CONTAINER_SEL) : null;
              hops++;
            }
            if (!targetInput || !targetInput.id) return;
            window.__flowtraceOpenerBindings.push({
              openerTitle: openerTitle,
              targetInputId: targetInput.id,
              at: Date.now(),
              consumed: false
            });
            // Cap history at 20 most recent to bound memory
            if (window.__flowtraceOpenerBindings.length > 20) {
              window.__flowtraceOpenerBindings.splice(0, window.__flowtraceOpenerBindings.length - 20);
            }
            console.log('__flowtrace_OPENER_TARGET__:' + JSON.stringify({
              openerTitle: openerTitle,
              targetInputId: targetInput.id
            }));
          } catch (_) {}
        }, true);

        // Menu item click capture. Oracle Fusion action menus (Actions ▸ More ▸
        // Issue Refund etc.) render items as role=menuitem inside a role=menu
        // popup. Playwright's codegen emits these as generic getByText / nth-based
        // role clicks, which are fragile. Emit a marker so post-processing can
        // rewrite to getByRole('menuitem', { name: 'X' }).
        // NOTE: role=menubar (top-level toolbar items like "Actions" that *open*
        // the menu) is intentionally excluded — we only mark items inside the
        // opened popup, not the opener itself.
        document.addEventListener('click', (e) => {
          try {
            const item = e.target.closest('[role="menuitem"]');
            if (!item) return;
            const container = item.closest('[role="menu"]');
            if (!container) return;
            // Additional guard: the menu must be in an open/visible state.
            if (container.offsetParent === null) return;
            const text = (item.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text || text.length > 80) return;
            console.log('__flowtrace_MENU_ITEM__:' + JSON.stringify({
              text: text,
              containerId: container.id || ''
            }));
          } catch (_) {}
        }, true);

        // Oracle SVG navigator tile click augmentation.
        // Oracle's `#itemNode_*` tiles render as SVG paths with no stable role/text.
        // Playwright codegen captures these as '#itemNode_* > .svg-nav > path:nth-child(N)'
        // clicks — Tasks/Create Transaction submenu items that the user reached via
        // expand-then-activate never surface as semantic getByRole steps. Capture
        // semantic context per click so post-processing can attach intent metadata.
        // Pure observation; no DOM mutation.
        document.addEventListener('click', (e) => {
          try {
            const tile = e.target.closest('[id^="itemNode_"]');
            if (!tile || !tile.id) return;
            const tileId = tile.id;
            const clicked = e.target;
            const clickedTag = (clicked.tagName || '').toLowerCase();
            let pathIndex = -1;
            if (clickedTag === 'path' && clicked.parentElement) {
              const siblings = [...clicked.parentElement.children].filter(c => c.tagName && c.tagName.toLowerCase() === 'path');
              pathIndex = siblings.indexOf(clicked);
            }
            const childQuery = '[role="menuitem"], a[id^="itemNode_"], li a, .af_menu_item';
            const beforeMenuItems = tile.querySelectorAll(childQuery).length;
            setTimeout(() => {
              try {
                const afterMenuItems = tile.querySelectorAll(childQuery).length;
                const navObservedExpansion = afterMenuItems > beforeMenuItems;
                const childLabels = [...tile.querySelectorAll(childQuery)]
                  .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
                  .filter(s => s && s.length <= 80)
                  .slice(0, 10);
                console.log('__flowtrace_NAV_TILE_CLICK__:' + JSON.stringify({
                  tileId: tileId,
                  clickedTag: clickedTag,
                  pathIndex: pathIndex,
                  beforeMenuItems: beforeMenuItems,
                  afterMenuItems: afterMenuItems,
                  navObservedExpansion: navObservedExpansion,
                  childLabels: childLabels
                }));
              } catch (_) {}
            }, 800);
          } catch (_) {}
        }, true);
