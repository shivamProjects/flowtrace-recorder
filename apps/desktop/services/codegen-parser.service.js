const { classifyOracleField, normalizeText } = require('../utils/oracleFieldClassifier');

class CodegenParserService {
  applyNavigationDedup(actions) {
    if (!Array.isArray(actions) || actions.length === 0) return actions;

    const isClick = (a) => a && a.type === 'playwright-code'
      && typeof a.code === 'string' && a.code.endsWith('.click()');

    const isHomeLink = (a) => isClick(a) && /page\.getByRole\(\s*['"]link['"][\s,]+\{[^}]*name:\s*['"]Home['"]/.test(a.code);
    const isTopNavLink = (a) => isClick(a) && /page\.getByRole\(\s*['"]link['"]/.test(a.code) && !isHomeLink(a);
    const isArrowClick = (a) => isClick(a) && a.code.includes('flat-tabs-overflow-');
    const isItemNode = (a) => isClick(a) && (a.code.includes("page.locator('#itemNode_") || a.code.includes('page.locator("#itemNode_'));
    const isClusterContainer = (a) => isClick(a) && a.code.includes('clusters_container');

    const isInNavSection = (a) => isHomeLink(a) || isTopNavLink(a) || isArrowClick(a) || isItemNode(a) || isClusterContainer(a);

    // 0. Pre-Home abandoned-nav cleanup. Oracle's autoscroll/focus on
    //    Home sometimes opens a wrong module drawer immediately after
    //    Sign In; the user clicks Home and starts again. Drop any
    //    topNavLink / itemNode / arrow / cluster clicks that appear
    //    BEFORE the first Home click — those are nav noise. Login fills
    //    and the Sign In button click stay (they're not nav-shaped).
    let firstHomeIdxScan = -1;
    for (let i = 0; i < actions.length; i++) {
      if (isHomeLink(actions[i])) { firstHomeIdxScan = i; break; }
    }
    if (firstHomeIdxScan > 0) {
      const dropPre = [];
      for (let i = 0; i < firstHomeIdxScan; i++) {
        if (isTopNavLink(actions[i]) || isItemNode(actions[i]) || isArrowClick(actions[i]) || isClusterContainer(actions[i])) {
          dropPre.push(i);
        }
      }
      if (dropPre.length > 0) {
        const preDropSet = new Set(dropPre);
        for (const idx of dropPre) {
          console.log(`[recorder] Pre-Home abandoned nav: dropped ${(actions[idx].code || '').substring(0, 100)}`);
        }
        actions = actions.filter((_, idx) => !preDropSet.has(idx));
        console.log(`[recorder] Pre-Home cleanup: ${dropPre.length} step(s) dropped before first Home click`);
      }
    }

    // 1. Find nav section. navStart anchors at first Home click so any
    //    earlier link clicks ('Forgot Password', etc.) stay verbatim.
    let navStart = -1, navEnd = -1;
    for (let i = 0; i < actions.length; i++) {
      if (isHomeLink(actions[i])) { navStart = i; navEnd = i; break; }
    }
    if (navStart === -1) return actions;
    for (let i = navStart + 1; i < actions.length; i++) {
      if (isInNavSection(actions[i])) navEnd = i;
      else break;
    }

    // 1b. Last tile = upper bound for Rules A/B/C/D. Anything past the last
    //     tile (Tasks, Create Transaction, etc.) is a business step.
    let lastTileInNav = -1;
    for (let i = navStart; i <= navEnd; i++) {
      if (isItemNode(actions[i])) lastTileInNav = i;
    }
    if (lastTileInNav === -1) {
      console.log('[recorder] canonical-nav: no tile in nav section, kept verbatim');
      return actions;
    }
    const canonicalEnd = lastTileInNav;

    // 2. itemNode→link dedup: ADF drawers expose icon+label as separate
    //    targets to the same page. Users click both; the icon click closes
    //    the drawer and the label click then fails. Match via
    //    navContext.childLabels on the itemNode = link name.
    const itemNodeLinkDupIndices = new Set();
    for (let i = navStart; i < navEnd; i++) {
      const cur = actions[i], next = actions[i + 1];
      if (!isItemNode(cur) || !next) continue;
      if (!cur.navContext || !Array.isArray(cur.navContext.childLabels)) continue;
      const linkMatch = next.code && next.code.match(/^page\.getByRole\(\s*['"]link['"][\s,]+\{[^}]*name:\s*['"]([^'"]+)['"][^}]*\}\s*\)\.click\(\)$/);
      if (!linkMatch) continue;
      const linkName = linkMatch[1];
      const matches = cur.navContext.childLabels.some(l => String(l).trim() === linkName.trim());
      if (matches) itemNodeLinkDupIndices.add(i + 1);
    }

    // 3. Apply Rules A/B/C/D (every drop logged — no silent drops).
    const extractItemNodeId = (a) => {
      const m = a && a.code && a.code.match(/page\.locator\(\s*['"]#itemNode_([\w_]+)['"]/);
      return m ? m[1] : null;
    };
    const extractLinkName = (a) => {
      const m = a && a.code && a.code.match(/getByRole\(\s*['"]link['"][\s,]+\{[^}]*name:\s*['"]([^'"]+)['"]/);
      return m ? m[1] : null;
    };
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s_]+/g, '');

    const droppedIndices = new Set();
    const dropLog = [];

    // Rule A: drop arrow clicks.
    for (let i = navStart; i <= canonicalEnd; i++) {
      if (isArrowClick(actions[i])) {
        droppedIndices.add(i);
        dropLog.push({ reason: 'arrow click', code: actions[i].code });
      }
    }

    // Rule B: drop module clicks whose window has no matching tile (bounded
    // to canonicalEnd so post-tile Tasks/Create links aren't seen as candidates).
    for (let i = navStart; i <= canonicalEnd; i++) {
      if (droppedIndices.has(i)) continue;
      if (!isTopNavLink(actions[i])) continue;
      const linkName = extractLinkName(actions[i]);
      if (!linkName) continue;
      const linkNorm = norm(linkName);
      let foundMatchingTile = false;
      for (let j = i + 1; j <= canonicalEnd; j++) {
        if (droppedIndices.has(j)) continue;
        if (isTopNavLink(actions[j])) break; // window ends at next module link
        if (isItemNode(actions[j])) {
          const tid = extractItemNodeId(actions[j]);
          if (tid && norm(tid).startsWith(linkNorm)) { foundMatchingTile = true; break; }
        }
      }
      if (!foundMatchingTile) {
        droppedIndices.add(i);
        dropLog.push({ reason: `accidental module click '${linkName}' (no matching tile in window)`, code: actions[i].code });
      }
    }

    // Rule C: drop cluster_container clicks.
    for (let i = navStart; i <= canonicalEnd; i++) {
      if (droppedIndices.has(i)) continue;
      if (isClusterContainer(actions[i])) {
        droppedIndices.add(i);
        dropLog.push({ reason: 'cluster_container click', code: actions[i].code });
      }
    }

    // itemNode-link dedup (full nav range — may add indices past canonicalEnd).
    for (const idx of itemNodeLinkDupIndices) {
      if (!droppedIndices.has(idx)) {
        droppedIndices.add(idx);
        dropLog.push({ reason: 'itemNode-label duplicate', code: actions[idx].code });
      }
    }

    // Rule D: dedup by category+name, keep last (reverse scan, canonical range only).
    const seenByKey = new Map();
    for (let i = canonicalEnd; i >= navStart; i--) {
      if (droppedIndices.has(i)) continue;
      let key = null;
      if (isHomeLink(actions[i])) key = 'home';
      else if (isTopNavLink(actions[i])) {
        const n = extractLinkName(actions[i]);
        if (n) key = 'topnav:' + norm(n);
      } else if (isItemNode(actions[i])) {
        const id = extractItemNodeId(actions[i]);
        if (id) key = 'itemnode:' + norm(id);
      }
      if (!key) continue;
      if (seenByKey.has(key)) {
        droppedIndices.add(i);
        dropLog.push({ reason: `duplicate ${key.split(':')[0]} (later instance kept)`, code: actions[i].code });
      } else {
        seenByKey.set(key, i);
      }
    }

    if (droppedIndices.size === 0) {
      console.log('[recorder] canonical-nav sanitization: nothing to drop, kept verbatim');
      return actions;
    }

    const canonicalNav = [];
    for (let i = navStart; i <= navEnd; i++) {
      if (!droppedIndices.has(i)) canonicalNav.push(actions[i]);
    }

    for (const d of dropLog) {
      console.log(`[recorder] canonical-nav: dropped ${d.reason} | ${(d.code || '').substring(0, 100)}`);
    }
    const navOriginalLen = navEnd - navStart + 1;
    console.log(`[recorder] canonical-nav sanitization: ${navOriginalLen} nav step(s) → ${canonicalNav.length} (${dropLog.length} dropped)`);

    const result = [...actions.slice(0, navStart), ...canonicalNav, ...actions.slice(navEnd + 1)];

    // Legacy summary log (kept for grep continuity).
    const parts = ['canonical-nav sanitization applied'];
    console.log(`[recorder] nav reconstruction: ${parts.join(' | ')}`);
    return result;
  }

  parseCodegenOutput(code, recorder) {
    const actions = [];
    const lines = code.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip boilerplate
      if (trimmed.startsWith('//') || trimmed.startsWith('const') ||
          trimmed.startsWith('import') || trimmed.startsWith('async function') ||
          trimmed.includes('test(') || trimmed === '' || trimmed === '}' ||
          trimmed === '});' || trimmed.includes('newContext') ||
          trimmed.includes('newPage') || trimmed.includes('close()')) {
        continue;
      }

      // Collect multi-line statements
      let fullStatement = trimmed;
      let j = i;
      while (!fullStatement.includes(';') && j < lines.length - 1) {
        j++;
        fullStatement += ' ' + lines[j].trim();
      }
      i = j;

      fullStatement = fullStatement.replace(/^await\s+/, '').replace(/;$/, '').trim();
      if (!fullStatement) continue;

      // Keep wrapper lines for backend script assembly
      if (!fullStatement.startsWith('page.')) {
        const isWrapper = fullStatement.startsWith('(async') || fullStatement === '})()';
        if (!isWrapper) continue;
        actions.push({ type: 'playwright-code', code: fullStatement, rawCode: fullStatement, skipInReport: true });
        continue;
      }

      // Skip about:blank in manual mode
      if (recorder.recordingMode === 'manual' && fullStatement.includes("page.goto('about:blank')")) continue;

      let processedStatement = fullStatement;

      // Trim whitespace from fill/pressSequentially values.
      // Leading/trailing spaces cause ADF LOV inline matching to fail.
      processedStatement = processedStatement.replace(
        /(\.(?:fill|pressSequentially)\(['"])(\s+)?([^'"]*?)(\s+)?(['"]\))/g,
        (_, pre, lead, value, trail, post) => (lead || trail) ? `${pre}${value}${post}` : `${pre}${lead || ''}${value}${trail || ''}${post}`
      );

      // Decode common HTML entities that Playwright codegen may capture from the DOM.
      if (processedStatement.includes('&amp;') || processedStatement.includes('&lt;') ||
          processedStatement.includes('&gt;') || processedStatement.includes('&quot;') ||
          processedStatement.includes('&#39;')) {
        processedStatement = processedStatement
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
      }

      // Oracle ADF access-key markers: ADF uses '&' before a letter as keyboard shortcut
      // markers in UI labels (e.g. "App&ly" = Alt+L for Apply, "S&ave" = Alt+A for Save).
      // Playwright codegen captures this raw text in hasText and getByText selectors.
      // These are always UI labels (buttons, tabs, headings) — never user data.
      // User data like "AT&T" appears in fill(), option, cell — which we don't touch.
      // Strip '&' before letters ONLY in hasText and getByText.
      if (processedStatement.includes('&')) {
        processedStatement = processedStatement.replace(
          /(hasText:\s*\/)([^/]+)(\/)/g,
          (_, pre, pattern, post) => pre + pattern.replace(/&(?=[a-zA-Z])/g, '') + post
        );
        processedStatement = processedStatement.replace(
          /(getByText\(')([^']+)('\))/g,
          (_, pre, text, post) => pre + text.replace(/&(?=[a-zA-Z])/g, '') + post
        );
        // Also strip from getByRole name for UI roles (button, link, tab, menuitem).
        // e.g. getByRole('button', { name: 'App&ly' }) → 'Apply'
        // Safe because buttons/links/tabs are always UI labels, never user data.
        processedStatement = processedStatement.replace(
          /(getByRole\('(?:button|link|tab|menuitem|heading)',\s*\{\s*name:\s*')([^']+)(')/g,
          (_, pre, name, post) => pre + name.replace(/&(?=[a-zA-Z])/g, '') + post
        );
      }

      // Replace redirect URLs with original URL
      if (recorder.originalUrl && fullStatement.includes('page.goto(')) {
        const gotoMatch = fullStatement.match(/page\.goto\(['"]([^'"]+)['"]\)/);
        if (gotoMatch) {
          const gotoUrl = gotoMatch[1];
          try {
            const originalDomain = new URL(recorder.originalUrl).hostname;
            const gotoDomain = new URL(gotoUrl).hostname;
            // Drop mid-flow goto with ADF session tokens — these are non-replayable
            // internal navigation URLs that Oracle ADF generates during page transitions
            if (/_adf\.ctrl-state|_afrLoop|_afrWindowId|_afrWindowMode/.test(gotoUrl)) {
              console.log(`[recorder] Dropped ADF session goto: ${gotoUrl.substring(0, 80)}...`);
              continue;
            }
            if (gotoDomain !== originalDomain || gotoUrl.length > 200) {
              processedStatement = `page.goto('${recorder.originalUrl}')`;
            }
          } catch (e) {}
        }
      }

      // ── SAFE normalizations ──

      // Normalize ADF LOV td.filter({ hasText: 'CONCAT' }) → getByRole('cell', { name: 'VALUE' }).
      // Playwright sometimes records LOV result clicks as locator('td').filter({ hasText: })
      // which captures concatenated text from multiple columns (e.g. "MANUAL OTHERManual Order").
      // Split at the boundary where ALL-CAPS text meets Title Case without space, take first part.
      const tdFilterMatch = processedStatement.match(/^page\.locator\('td'\)\.filter\(\{\s*hasText:\s*'([^']+)'\s*\}\)\.click\(\)$/);
      if (tdFilterMatch) {
        const fullText = tdFilterMatch[1];
        // Detect ALL-CAPS ending directly joined to Title Case start (no space)
        const splitMatch = fullText.match(/^(.*[A-Z])(?=[A-Z][a-z])/);
        const firstValue = (splitMatch && splitMatch[1][splitMatch[1].length - 1] !== ' ')
          ? splitMatch[1].trim()
          : fullText;
        processedStatement = `page.getByRole('cell', { name: '${firstValue}', exact: true }).click()`;
        if (firstValue !== fullText) {
          console.log(`[recorder] LOV td.filter normalized: '${fullText}' → cell '${firstValue}'`);
        }
      }

      // Enrich truncated LOV cell names using captured click data.
      // Playwright codegen records partial ARIA names (e.g. 'Data Conversion -') but the
      // actual cell value is 'Data Conversion -9053'. Use lovCellMap to replace with the
      // primary cell value captured during recording.
      // GUARD: only enrich if the captured primary is LONGER than the recorded name.
      // This prevents cross-section contamination where a short code like '001' from the
      // Distribution section overwrites a full name like 'McGrath RentCorp' from the BU LOV.
      // Truncation always makes names shorter, so longer primary = genuine enrichment.
      if (recorder.lovCellMap) {
        const cellNameMatch = processedStatement.match(/getByRole\('(?:cell|gridcell)',\s*\{\s*name:\s*'([^']+)'/);
        if (cellNameMatch) {
          const recorded = cellNameMatch[1];
          const primary = recorder.lovCellMap[recorded];
          if (primary && primary !== recorded && primary.length > recorded.length) {
            processedStatement = processedStatement.replace(
              `name: '${recorded}'`,
              `name: '${primary}'`
            );
            console.log(`[recorder] LOV cell name enriched: '${recorded}' → '${primary}'`);
          }
        }
      }

      // Replace fragile .nth(N) cell selectors with row-based selectors.
      // When multiple cells share the same text (e.g. '001' appearing in every row
      // of a Distribution table), Playwright records getByRole('cell', { name: '001' }).nth(5).
      // This breaks when the data has fewer rows. Replace with a row filter that matches
      // the full row text, then .first() within that row.
      const nthCellMatch = processedStatement.match(/^page\.getByRole\('(?:cell|gridcell)',\s*\{\s*name:\s*'([^']+)'(?:,\s*exact:\s*true)?\s*\}\)\.nth\((\d+)\)\.click\(\)$/);
      if (nthCellMatch && recorder.nthCellRowMap) {
        const cellText = nthCellMatch[1];
        const nthIdx = parseInt(nthCellMatch[2], 10);
        const key = `${cellText}::nth(${nthIdx})`;
        const rowData = recorder.nthCellRowMap[key];
        if (rowData && rowData.row) {
          // Use the full row text to find the right row, then select the cell within it
          // Escape regex special chars in the row text for hasText filter
          const rowText = rowData.row;
          processedStatement = `page.getByRole('row', { name: '${rowText}' }).getByRole('cell', { name: '${cellText}' }).first().click()`;
          console.log(`[recorder] nth(${nthIdx}) → row-based: cell '${cellText}' in row '${rowText.substring(0, 60)}...'`);
        }
      }

      // Strip timestamps from text-based selectors and convert to regex prefix match.
      // Oracle ADF often shows live status text like "Ready for download 5/15/26 12:06 PM",
      // "Last updated 5/15/26 10:30 AM", "Created on May 15, 2026". These timestamps
      // change between recording and replay, breaking the script. Detect date/time
      // patterns inside getByText / getByRole name selectors and replace the literal
      // text with a regex anchored to the prefix.
      //
      // Patterns covered:
      //   M/D/YY, M/D/YYYY (e.g. 5/15/26, 05/15/2026)
      //   HH:MM, HH:MM AM/PM (e.g. 12:06, 12:06 PM)
      //   Month-name dates (Jan 15 2026, January 15, 2026)
      //   Bare year-suffix (e.g. ' 2026' at end)
      const TIMESTAMP_RE = /\s+(?:\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}:\d{2}(?:\s*[AP]M)?|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?)/i;

      // Helper: escape regex special chars in a literal text for embedding in a /regex/
      const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Append .first() to a locator chain if not already present and not followed by
      // another disambiguator (.last() / .nth() / .filter()). Inserts between the locator
      // call and the action (.click() / .fill() / .press() / etc).
      // Regex selectors with timestamp prefixes often match multiple elements (e.g. status
      // history rows + main link). Adding .first() picks the most recent / topmost match,
      // matching what the user clicked during recording.
      const ensureFirst = (stmt, locatorPattern) => {
        // If chain already has a disambiguator immediately after the locator, leave it alone
        const re = new RegExp(`${locatorPattern}(\\.(?:first|last|nth|filter|all|or)\\()`);
        if (re.test(stmt)) return stmt;
        // Otherwise insert .first() before the action
        const re2 = new RegExp(`(${locatorPattern})\\.((?:click|dblclick|fill|press|pressSequentially|selectOption|check|uncheck|hover|focus|tap)\\()`);
        return stmt.replace(re2, '$1.first().$2');
      };

      // Rule A: getByText('...timestamp...')
      const gbtMatch = processedStatement.match(/getByText\('([^']+)'(?:,\s*\{[^}]*\})?\)/);
      if (gbtMatch) {
        const literal = gbtMatch[1];
        const tsIdx = literal.search(TIMESTAMP_RE);
        if (tsIdx > 0) {
          const prefix = literal.substring(0, tsIdx).trim();
          if (prefix.length >= 3) {
            const pattern = `/^${escapeRegex(prefix)}/`;
            processedStatement = processedStatement.replace(
              /getByText\('[^']+'(?:,\s*\{[^}]*\})?\)/,
              `getByText(${pattern})`
            );
            // Regex selectors typically match multiple elements (e.g. status history rows);
            // pick the first match to mirror the user's recorded click on the topmost item.
            processedStatement = ensureFirst(processedStatement, 'getByText\\(/[^/]+/\\)');
            console.log(`[recorder] Timestamp stripped from getByText: '${literal}' → ${pattern} (.first() added)`);
          }
        }
      }

      // Rule B: getByRole('X', { name: '...timestamp...' })
      const gbrMatch = processedStatement.match(/getByRole\('([^']+)',\s*\{\s*name:\s*'([^']+)'(?:,\s*exact:\s*true)?\s*\}\)/);
      if (gbrMatch) {
        const role = gbrMatch[1];
        const literal = gbrMatch[2];
        const tsIdx = literal.search(TIMESTAMP_RE);
        if (tsIdx > 0) {
          const prefix = literal.substring(0, tsIdx).trim();
          if (prefix.length >= 3) {
            const pattern = `/^${escapeRegex(prefix)}/`;
            // Drop exact:true if present — regex matching shouldn't be paired with exact
            processedStatement = processedStatement.replace(
              /getByRole\('[^']+',\s*\{\s*name:\s*'[^']+'(?:,\s*exact:\s*true)?\s*\}\)/,
              `getByRole('${role}', { name: ${pattern} })`
            );
            // Same disambiguation: regex names commonly match multiple elements.
            processedStatement = ensureFirst(processedStatement, `getByRole\\('${escapeRegex(role)}',\\s*\\{\\s*name:\\s*/[^/]+/\\s*\\}\\)`);
            console.log(`[recorder] Timestamp stripped from getByRole('${role}'): '${literal}' → ${pattern} (.first() added)`);
          }
        }
      }

      // Normalize Oracle ADF LOV button runtime IDs → stable suffix selector.
      // The full ID like pt1:_FOr1:1:_FONSr2:0:MAnt2:1:pt1:TCF:0:ap1:fcslov1:sis1:is1::btn
      // has a session-specific prefix but a stable suffix: :fcslovN:sis1:is1::btn
      // We replace with [id$="...::btn"] so it works across page loads.
      if (processedStatement.includes('::btn"') || processedStatement.includes("::btn'")) {
        const btnIdMatch = processedStatement.match(/\[id=["']([^"']+::btn)["']\]/);
        if (btnIdMatch) {
          const fullId = btnIdMatch[1];
          // Extract stable suffix: everything from the last :fcslovN segment onward
          const stableSuffix = fullId.match(/(:[a-z]+\d*(?::sis\d+)*(?::is\d+)*::btn)$/i);
          if (stableSuffix) {
            processedStatement = processedStatement.replace(
              /\[id=["'][^"']+::btn["']\]/,
              `[id$="${stableSuffix[1]}"]`
            );
          }
        }
      }

      // Normalize Oracle ADF context menu item runtime IDs → stable suffix selector.
      // Pattern: pt1:_FOr1:1:_FONSr2:0:MAnt2:2:pt1:Trans1:0:ap110:cmi10
      //   The :ap\d+:cmi\d+ tail is stable across sessions; the prefix
      //   (_FOr1:1:_FONSr2:0:MAnt2:N:...) changes per session.
      //   Replace with [id$="...:apN:cmiM"] so it survives re-login.
      //   Only fires when the captured ID ends with :cmi\d+ — keeps non-menu IDs untouched.
      const cmiIdMatch = processedStatement.match(/\[id=["']([^"']+:cmi\d+)["']\]/);
      if (cmiIdMatch) {
        const fullId = cmiIdMatch[1];
        // Capture the last :apN:cmiM pair when present, otherwise just :cmiM
        const cmiStable = fullId.match(/(:ap\d+:cmi\d+)$/) || fullId.match(/(:cmi\d+)$/);
        if (cmiStable) {
          processedStatement = processedStatement.replace(
            /\[id=["'][^"']+:cmi\d+["']\]/,
            `[id$="${cmiStable[1]}"]`
          );
          console.log(`[recorder] Menu item ID normalized to suffix: ...${cmiStable[1]}`);
        }
      }

      // Normalize session-specific select[name="pt1:..."] to stable selector.
      // Priority 1: use getByLabel('FieldName') if we captured the field name during recording.
      // Priority 2: use [name$=":stable:suffix"] for cross-session stability.
      const selectNameMatch = processedStatement.match(/locator\('select\[name=["']([^"']+)["']\]'\)/);
      if (selectNameMatch) {
        const fullName = selectNameMatch[1];
        // Check if we have a field name mapping from the live DOM capture
        const fieldLabel = recorder.selectFieldMap && recorder.selectFieldMap[fullName];
        if (fieldLabel) {
          processedStatement = processedStatement.replace(
            /locator\('select\[name=["'][^"']+["']\]'\)/,
            `getByLabel('${fieldLabel}')`
          );
          console.log(`[recorder] Select normalized to label: '${fieldLabel}'`);
        } else {
          // Fallback: extract stable suffix :tableN:N:socN
          const stableSuffix = fullName.match(/(:[a-zA-Z]+\d*:\d+:[a-zA-Z]+\d*)$/);
          if (stableSuffix) {
            processedStatement = processedStatement.replace(
              /locator\('select\[name=["'][^"']+["']\]'\)/,
              `locator('select[name$="${stableSuffix[1]}"]')`
            );
            console.log(`[recorder] Select name normalized to suffix: ...${stableSuffix[1]}`);
          }
        }
      }

      // Skip ARIA popup text (not real elements)
      if (processedStatement.includes('has a popup, press') || processedStatement.includes('has a popup,')) continue;

      // Skip generic tag+nth noise — locator('div').nth(N), locator('span').nth(N) etc.
      // BUT: keep if inside Oracle navigation context (clusters, itemNode, module tabs)
      if (/^page\.locator\('(div|span|td|tr|li|ul|ol)'\)\.nth\(\d+\)\.click\(\)$/.test(processedStatement)) {
        if (!processedStatement.includes('#clusters') && !processedStatement.includes('#itemNode')) continue;
      }

      // Strip .nth(N) from transient dismiss controls (Close, Done, Cancel links).
      // These controls appear/disappear based on dialog state — .nth(N) makes them fragile.
      // Replace .nth(N) with .first() which is more resilient to dialog structure changes.
      if (/getByRole\('link',\s*\{\s*name:\s*'(?:Close|Done|Cancel)'/.test(processedStatement) && /\.nth\(\d+\)/.test(processedStatement)) {
        processedStatement = processedStatement.replace(/\.nth\(\d+\)/, '.first()');
        console.log(`[recorder] Transient dismiss: replaced .nth() with .first() — ${processedStatement.substring(0, 60)}`);
      }

      // Skip clicks directly on container roles (tablist, toolbar, menubar — noise).
      // BUT: keep clicks on children within those containers (e.g. Oracle ADF LOV search
      // button recorded as getByRole('toolbar', ...).getByTitle('Search: X').click()).
      // Detection: if there is any child locator chain after the role selector, keep it.
      if (/getByRole\('(tablist|toolbar|menubar)',/.test(processedStatement) && processedStatement.includes('.click()')) {
        const containerRoleMatch = processedStatement.match(/getByRole\('(?:tablist|toolbar|menubar)'[^)]*\)/);
        if (containerRoleMatch) {
          const afterRole = processedStatement.slice(
            processedStatement.indexOf(containerRoleMatch[0]) + containerRoleMatch[0].length
          );
          // No child locator after the role → it's a bare container click → drop
          if (!afterRole.match(/\.(getBy|locator|filter)\(/)) continue;
          // Has child (e.g. .getByTitle('Search: X')) → keep
        } else {
          continue;
        }
      }

      // KEEP overflow tab scroll clicks (.flat-tabs-overflow-*-svg) — these are
      // how users reveal hidden module tabs (Payables, Receivables, etc.) when
      // the Home page tab bar overflows. Earlier logic dropped them as "noise"
      // which caused entire flows to fail because modules stayed hidden at
      // replay time (seen in 2026-04-18 executions 998 / 1001). Generic bare
      // '.suiicon' (no flat-tabs-overflow class) is still dropped as best-effort
      // for stray icon clicks with no stable target.
      // NOTE: #clusters_container drop removed — module tab clicks within clusters
      // are real navigation actions (Payables, Receivables, etc). Dropping them
      // removes prerequisite navigation that causes replay failures.
      if (processedStatement === "page.locator('.suiicon').click()" ||
          processedStatement === "page.locator('.suiicon').first().click()") continue;

      // Normalize Home locator variants
      processedStatement = processedStatement.replace(
        /page\.locator\('(td|div)'\)\.filter\(\{\s*hasText:\s*\/\^Home\$\/\s*\}\)(?:\.nth\(1\))?\.click\(\)/g,
        `page.getByRole('link', { name: 'Home', exact: true }).click()`
      );
      processedStatement = processedStatement.replace(
        /page\.locator\('div'\)\.filter\(\{\s*hasText:\s*\/\^Home\$\/\s*\}\)\.first\(\)\.click\(\)/g,
        `page.getByRole('link', { name: 'Home', exact: true }).click()`
      );

      // Fix Oracle ADF task panel compound-text selectors.
      // When a task panel renders "Section HeaderLink Name" as concatenated DOM text,
      // Playwright codegen records getByText('Section HeaderLink Name').click() which
      // is brittle and may match the container rather than the link.
      // Heuristic: if getByText() text is >30 chars and contains known link keywords,
      // extract the link name (everything after the last capital-letter word boundary
      // that looks like a link: "Manage ...", "Create ...", "Review ...", etc.)
      if (/^page\.getByText\('([^']{30,})'\)(?:\.first\(\))?\.click\(\)$/.test(processedStatement)) {
        const textMatch = processedStatement.match(/^page\.getByText\('([^']+)'\)(?:\.first\(\))?\.click\(\)$/);
        if (textMatch) {
          const fullText = textMatch[1];
          // Extract the last meaningful action-link segment (starts with verb like Manage/Create/Review/Add/Apply/Submit/Approve/Post/Confirm)
          const linkPart = fullText.match(/((?:Manage|Create|Review|Add|Apply|Submit|Approve|Post|Confirm|Edit|View|Search|Run|Schedule|Process|Generate|Import|Export|Upload|Download|Close|Cancel|Delete|Remove|Copy|Duplicate|Print|Send|Complete|Finalize|Set|Update|Change|Assign|Transfer|Convert|Correct|Reverse|Void|Adjust|Reconcile|Match|Clear|Lock|Unlock|Open|Reopen|Activate|Deactivate|Enable|Disable|Validate|Verify|Publish|Deploy|Withdraw|Recall|Release|Hold|Unhold|Mark|Flag|Archive|Restore)\s[A-Za-z ]+)$/);
          if (linkPart) {
            const linkName = linkPart[1].trim();
            processedStatement = `page.getByRole('link', { name: '${linkName}', exact: true }).click()`;
            console.log(`[recorder] task-panel compound text normalized: '${fullText}' → link '${linkName}'`);
          }
        }
      }

      // Do NOT add exact:true to getByRole('link') clicks.
      // Playwright codegen uses partial link names (e.g. 'Manage Credit Memo' for a link
      // whose full text is 'Manage Credit Memo Applications'). Without exact:true,
      // Playwright's substring matching finds the right link. The replayer's .first()
      // handles any ambiguity from multiple partial matches.

      // Add exact:true to getByRole('gridcell') and getByRole('cell') — Oracle ADF pages
      // often have multiple cells with overlapping names (e.g. "McGrath RentCorp" appears in
      // both the LOV dialog and the background form), causing strict mode violations.
      if (processedStatement.includes("getByRole('gridcell',") || processedStatement.includes("getByRole('cell',")) {
        processedStatement = processedStatement.replace(
          /getByRole\('(gridcell|cell)',\s*\{\s*name:\s*'([^']+)'\s*\}\)/g,
          (match, role, name) => match.includes('exact:') ? match : `getByRole('${role}', { name: '${name}', exact: true })`
        );
      }

      // Date picker enrichment: gridcell with a 1-31 day name → expand to full
      // date and tag with date-select metadata. Tolerates `.nth()/.first()/.last()`
      // because adjacent-month overflow cells repeat day numbers (e.g. three cells named '3').
      if (recorder.datePickerMap) {
        const dateGridMatch = processedStatement.match(/getByRole\('(?:gridcell|cell)',\s*\{\s*name:\s*'(\d{1,2})'(?:,\s*exact:\s*true)?\s*\}\)(?:\.nth\(\d+\)|\.first\(\)|\.last\(\))?\.click\(\)$/);
        if (dateGridMatch) {
          const dayStr = dateGridMatch[1];
          const dayNum = parseInt(dayStr, 10);
          if (dayNum >= 1 && dayNum <= 31 && recorder.datePickerMap[dayStr]) {
            const dateInfo = recorder.datePickerMap[dayStr];
            // Tag this entry with date-select metadata (applied to entry after push)
            recorder._pendingDateSelect = {
              action: 'date-select',
              dayValue: dayStr,
              monthOffset: dateInfo.monthOffset,
              originalValue: dateInfo.fullDate,
              displayValue: dateInfo.fullDate,
              targetFieldId: dateInfo.targetFieldId || ''
            };
            console.log(`[recorder] Date picker: day '${dayStr}' → full date '${dateInfo.fullDate}'`);
            // Clean up — each date click consumes its mapping
            delete recorder.datePickerMap[dayStr];
          }
        }
      }

      // Date-picker family fallback: gridcell click with a non-day name
      // (".", "", "April 18" or similar) when dateInputValueMap has an unclaimed
      // committed value. Oracle ADF calendar cells sometimes expose aria-labels
      // Playwright captures as "." or empty when the cell has hidden nodes.
      //
      // CONTEXT GUARD (family rule): only fire when a real date-picker is the
      // most-recent opener. Without this, a cell click inside a later-opened
      // Search/Select LOV dialog (e.g. a Distribution result row whose content
      // happens to be '4/5/26') gets tagged action:'date-select' and consumes
      // the invoice-date committed value — which the replayer then fills into
      // whatever date-like input it finds, landing in the wrong field.
      //
      // Two-sided guard:
      //   positive — a recent Select/Choose Date opener (active date picker)
      //              within the last 8 pushed actions
      //   negative — no more-recent Search:/Select: LOV opener intervening
      // This is a date-picker-family rule, not a per-field workaround.
      if (!recorder._pendingDateSelect && recorder.dateInputValueMap && Object.keys(recorder.dateInputValueMap).length > 0) {
        // Same `.nth/.first/.last` tolerance as the day-number matcher above.
        const anyCellMatch = processedStatement.match(/getByRole\('(?:gridcell|cell)',\s*\{\s*name:\s*'([^']*)'(?:,\s*exact:\s*true)?\s*\}\)(?:\.nth\(\d+\)|\.first\(\)|\.last\(\))?\.click\(\)$/);
        if (anyCellMatch) {
          const capturedName = anyCellMatch[1];
          const isValidDay = /^\d{1,2}$/.test(capturedName) &&
                             parseInt(capturedName, 10) >= 1 && parseInt(capturedName, 10) <= 31;
          if (!isValidDay) {
            const lookback = actions.slice(-8);
            let lastDateOpenerPos = -1, lastLovOpenerPos = -1;
            for (let p = lookback.length - 1; p >= 0; p--) {
              const c = lookback[p] && lookback[p].code;
              if (!c) continue;
              if (lastDateOpenerPos === -1 && /getByTitle\('(?:Select|Choose) Date'/i.test(c)) {
                lastDateOpenerPos = p;
              }
              if (lastLovOpenerPos === -1 && (
                /getByTitle\('(?:Search|Select):/i.test(c) ||
                /getByRole\('link',\s*\{\s*name:\s*'(?:Search|Select):/i.test(c)
              )) {
                lastLovOpenerPos = p;
              }
            }
            const hasDateContext = lastDateOpenerPos !== -1 &&
                                   (lastLovOpenerPos === -1 || lastLovOpenerPos < lastDateOpenerPos);
            if (hasDateContext) {
              if (!recorder._consumedDateFieldIds) recorder._consumedDateFieldIds = new Set();
              const datePattern = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
              for (const [fieldId, value] of Object.entries(recorder.dateInputValueMap)) {
                if (recorder._consumedDateFieldIds.has(fieldId)) continue;
                if (!datePattern.test(value)) continue;
                console.log(`[recorder] Date gridcell fallback: bogus name '${capturedName}' → committed value '${value}' (field ${fieldId})`);
                processedStatement = processedStatement.replace(
                  /getByRole\('(?:gridcell|cell)',\s*\{\s*name:\s*'[^']*'(?:,\s*exact:\s*true)?\s*\}\)/,
                  `getByRole('cell', { name: '${value}', exact: true })`
                );
                const parts = value.split('/');
                recorder._pendingDateSelect = {
                  action: 'date-select',
                  dayValue: parts[1] || '',
                  monthOffset: 0,
                  originalValue: value,
                  displayValue: value,
                  targetFieldId: fieldId
                };
                recorder._consumedDateFieldIds.add(fieldId);
                break;
              }
            } else {
              console.log(`[recorder] Date gridcell fallback skipped for '${capturedName}': no active date-picker context (dateOpener=${lastDateOpenerPos}, lovOpener=${lastLovOpenerPos})`);
            }
          }
        }
      }

      // Login button cleanup: Playwright's getByText can concatenate sibling text
      // (e.g. "Forgot Password" link + "Sign In" button → "Forgot Password Sign In"),
      // losing the semantic button click. When the captured text ends with a known
      // submit-style button word, rewrite to an explicit button role selector.
      const getByTextClickMatch = processedStatement.match(/getByText\('([^']+)'(?:,\s*\{\s*exact:\s*true\s*\})?\)\.click\(\)$/);
      if (getByTextClickMatch) {
        const text = getByTextClickMatch[1];
        const submitMatch = text.match(/\b(Sign In|Log In|Login|Submit|Continue)\b/i);
        if (submitMatch && text.trim() !== submitMatch[0].trim()) {
          const buttonName = submitMatch[0];
          console.log(`[recorder] Text-concat cleanup: '${text}' → button '${buttonName}'`);
          processedStatement = processedStatement.replace(
            /getByText\('[^']+'(?:,\s*\{\s*exact:\s*true\s*\})?\)/,
            `getByRole('button', { name: '${buttonName}' })`
          );
        }
      }

      // Semantic button normalization: Playwright codegen sometimes emits
      // locator('td'/'table'/'div'/'span').filter({ hasText: /^Save$/ }).click()
      // for cells that happen to wrap a button. These DOM-shape selectors are
      // fragile. Rewrite to getByRole('button') when the filter text is a known
      // toolbar/action button label.
      const filterButtonMatch = processedStatement.match(
        /locator\('(?:td|table|div|span)'\)\.filter\(\{\s*hasText:\s*\/\^([^$/]+)\$\/\s*\}\)\.click\(\)$/
      );
      if (filterButtonMatch) {
        const btnText = filterButtonMatch[1].trim();
        if (/^(Save|Save and Close|Done|OK|Cancel|Submit|Apply|Close|Search|Reset|Next|Previous|Continue|Yes|No)$/i.test(btnText)) {
          console.log(`[recorder] Filter→button cleanup: '${btnText}'`);
          processedStatement = processedStatement.replace(
            /locator\('(?:td|table|div|span)'\)\.filter\(\{\s*hasText:\s*\/\^[^$/]+\$\/\s*\}\)/,
            `getByRole('button', { name: '${btnText}' })`
          );
        }
      }

      // Menu-scoped capture: when a click target was a role=menuitem inside an
      // open menu/popup, the runtime listener emitted __flowtrace_MENU_ITEM__. Here
      // we rewrite generic getByText / getByRole('link' or 'button').nth(N) clicks
      // on those exact item texts to getByRole('menuitem', { name: 'X' }) — which
      // is stable across menu re-renders and doesn't depend on page-global position.
      if (recorder.menuItemSet && recorder.menuItemSet.size > 0) {
        // Pattern A: getByText('X'[, { exact: true }]).click()
        const textMenuMatch = processedStatement.match(/getByText\('([^']+)'(?:,\s*\{\s*exact:\s*true\s*\})?\)\.click\(\)$/);
        if (textMenuMatch && recorder.menuItemSet.has(textMenuMatch[1].trim())) {
          const itemName = textMenuMatch[1].trim();
          console.log(`[recorder] Menu scope: getByText('${itemName}') → menuitem`);
          processedStatement = processedStatement.replace(
            /getByText\('[^']+'(?:,\s*\{\s*exact:\s*true\s*\})?\)/,
            `getByRole('menuitem', { name: '${itemName}' })`
          );
        } else {
          // Pattern B: getByRole('link'|'button', { name: 'X' })[.nth(N)].click()
          const roleMenuMatch = processedStatement.match(/getByRole\('(?:link|button)',\s*\{\s*name:\s*'([^']+)'(?:,\s*exact:\s*true)?\s*\}\)(?:\.nth\(\d+\))?\.click\(\)$/);
          if (roleMenuMatch && recorder.menuItemSet.has(roleMenuMatch[1].trim())) {
            const itemName = roleMenuMatch[1].trim();
            console.log(`[recorder] Menu scope: getByRole('link|button','${itemName}')[.nth] → menuitem`);
            processedStatement = processedStatement.replace(
              /getByRole\('(?:link|button)',\s*\{\s*name:\s*'[^']+'(?:,\s*exact:\s*true)?\s*\}\)(\.nth\(\d+\))?/,
              `getByRole('menuitem', { name: '${itemName}' })`
            );
          }
        }
      }

      // Strip trailing numeric IDs from LOV option names when fill value matches
      if (/getByRole\('option'/.test(processedStatement) && actions.length > 0) {
        const optMatch = processedStatement.match(/getByRole\('option',\s*\{\s*name:\s*'(.+?)\s+(\d+)'\s*\}\)/);
        if (optMatch) {
          const hasFillMatch = actions.slice(-3).some(a =>
            a.code.includes('.fill(') && a.code.includes(`'${optMatch[1]}'`)
          );
          if (hasFillMatch) {
            processedStatement = processedStatement.replace(
              /getByRole\('option',\s*\{\s*name:\s*'(.+?)\s+\d+'\s*\}\)/,
              (_, name) => `getByRole('option', { name: '${name}' })`
            );
          }
        }

        // ADF LOV: the option's ARIA name concatenates all table columns
        // (e.g. "Intercompany Invoice imported from..."), but the field only commits
        // the first column value (e.g. "Intercompany" — what was typed to filter).
        // Replace the option name with the fill value from the preceding combobox fill.
        const optNameMatch = processedStatement.match(/getByRole\('option',\s*\{\s*name:\s*'([^']+)'\s*\}\)/);
        if (optNameMatch) {
          const fullOptionName = optNameMatch[1];
          // Look back up to 5 actions for a combobox fill that is a prefix of the option name
          const recentFill = actions.slice(-5).reverse().find(a => {
            const fillMatch = a.code.match(/getByRole\('combobox'[^)]*\)\.(?:fill|pressSequentially)\('([^']+)'\)/);
            if (!fillMatch) return false;
            const typed = fillMatch[1].trim().toLowerCase();
            return fullOptionName.toLowerCase().startsWith(typed) && typed.length > 0;
          });
          if (recentFill) {
            const fillVal = recentFill.code.match(/\.(?:fill|pressSequentially)\('([^']+)'\)/)[1];
            // Only replace if the full option name is longer than the typed value
            // (i.e. the extra text came from ADF's second column)
            if (fullOptionName.length > fillVal.length) {
              // Find the option text that starts with fillVal — use the first word-boundary
              // portion that matches the fill prefix. We take the first "word group" of the
              // option name that starts with fillVal as typed.
              const optWords = fullOptionName.split(' ');
              let truncated = '';
              for (const w of optWords) {
                const candidate = truncated ? truncated + ' ' + w : w;
                if (candidate.toLowerCase().startsWith(fillVal.toLowerCase()) || fillVal.toLowerCase().startsWith(candidate.toLowerCase())) {
                  truncated = candidate;
                  // Stop once truncated covers the fill value — don't extend into
                  // repeated/second-column words (e.g. "MANUAL TESTING MANUAL TESTING"
                  // should stop at "MANUAL TESTING", not consume the duplicate).
                  if (truncated.length >= fillVal.length) break;
                } else if (truncated) {
                  break; // stop once we've moved past the fill prefix zone
                }
              }
              // Only apply if truncated is meaningfully shorter than full name and starts with fill
              if (truncated && truncated.length < fullOptionName.length && truncated.toLowerCase().startsWith(fillVal.toLowerCase())) {
                console.log(`[recorder] ADF LOV option name truncated: '${fullOptionName}' → '${truncated}' (fill was '${fillVal}')`);
                processedStatement = processedStatement.replace(
                  /getByRole\('option',\s*\{\s*name:\s*'[^']+'\s*\}\)/,
                  `getByRole('option', { name: '${truncated}' })`
                );
              }
            }
          }
        }
      }

      // Recorder noise: Playwright emits page.locator('html').(click|dblclick)()
      // as a fallback when the click lands outside any stable selector (stray
      // click on background / overlay dismiss / focus change). Replays fragile
      // — <html> is never considered visible by Playwright's click-stability
      // checks, times out after ~30s. Never represents user intent.
      if (/^page\.locator\('html'\)\.(?:dbl)?click\(\)$/.test(processedStatement)) {
        console.log('[recorder] Dropped html root click (Playwright fallback noise)');
        continue;
      }

      // Collapse SVG child selectors to stable parent
      // Keep SVG clicks that are inside navigation context (#clusters, #itemNode)
      // When collapsing, preserve the original child chain as _pendingRawSubSelector
      // so the next pushed action can record it in navContext.rawSubSelector —
      // two consecutive collapsed #itemNode_* clicks still get differentiable
      // metadata (e.g. path:nth-child(4) vs path:nth-child(2)).
      const selectorMatch = processedStatement.match(/page\.locator\('([^']+)'\)(?:\.first\(\))?\.(?:dbl)?click\(\)/);
      if (selectorMatch) {
        const sel = selectorMatch[1];
        if (sel.startsWith('path') || sel.startsWith('svg') || sel.includes('.svg-') || sel.includes('> svg') || sel.includes('> path')) {
          const stableId = sel.match(/^(#[\w:-]+)\s*>/);
          if (stableId) {
            recorder._pendingRawSubSelector = sel;
            processedStatement = "page.locator('" + stableId[1] + "').click()";
          } else if (sel.startsWith('path') || sel.startsWith('svg')) {
            // Keep if inside navigation context, otherwise drop
            if (sel.includes('#clusters') || sel.includes('#itemNode') || sel.includes('nav')) {
              // Normalize to a broader parent click instead of dropping
              console.log(`[recorder] SVG nav click preserved: ${sel.substring(0, 60)}`);
            } else {
              console.log(`[recorder] Orphan SVG/path click dropped (no nav context): ${sel.substring(0, 80)}`);
              continue;
            }
          }
        }
      }

      // Replace numeric selectOption values with display labels captured during recording.
      // e.g. getByLabel('Subledger Application').selectOption('14') → selectOption({ label: 'Payables' })
      if (processedStatement.includes('.selectOption(') && recorder.selectOptionMap) {
        processedStatement = processedStatement.replace(
          /\.selectOption\(['"]([^'"]+)['"]\)/,
          (_, val) => {
            const label = recorder.selectOptionMap[val];
            return label ? `.selectOption({ label: '${label}' })` : `.selectOption('${val}')`;
          }
        );
      }

      // LOV dedup — skip duplicate getByText click only if prev was also the same getByText click
      // (not after option click — that would drop the value-confirmation step Oracle ADF needs)
      // Handles .click(), .first().click(), .last().click(), .nth(N).click()
      const lovDup = processedStatement.match(/^page\.getByText\('([^']+)'\)(?:\.(?:first|last)\(\)|\.nth\(\d+\))?\.click\(\)$/);
      if (lovDup && actions.length > 0) {
        const prev = actions[actions.length - 1].code;
        if (prev.match(/^page\.getByText\(/) && prev.includes(`'${lovDup[1]}'`) && prev.includes('.click()')) continue;
      }

      // NOTE: Task-panel getByText drops disabled — the heuristic was removing
      // real navigation steps. All getByText clicks are now preserved.

      // Tag with required classification.
      // Priority: 1) Live page explicit required  → live-page-required
      //           2) Live page explicit optional  → live-page-optional (future)
      //           3) Classifier exact match       → required-exact / optional-exact
      //           4) Classifier contains match    → required-contains / optional-contains
      //           5) Field-name-pattern heuristic → field-name-pattern

      // Broad field-name extraction from selector
      const fieldMatch = processedStatement.match(
        /(?:getByRole\('(?:textbox|combobox|spinbutton|listbox|searchbox)',\s*\{\s*name:\s*'([^']+)')|(?:getByLabel\('([^']+)'\))|(?:getByTitle\('(?:Search:\s*)?([^']+)'\))|(?:getByPlaceholder\('([^']+)'\))/
      );
      let fieldName = fieldMatch ? (fieldMatch[1] || fieldMatch[2] || fieldMatch[3] || fieldMatch[4]) : null;

      // Fallback: extract from cell label context (e.g. cell.getByLabel('Amount'))
      if (!fieldName) {
        const cellLabelMatch = processedStatement.match(/getByLabel\('([^']+)'\)/);
        if (cellLabelMatch) fieldName = cellLabelMatch[1];
      }

      const normField = fieldName ? normalizeText(fieldName) : null;

      const entry = { type: 'playwright-code', code: processedStatement, rawCode: processedStatement };
      if (normField) {
        // 1. Check live-detected required fields (from page DOM scan)
        const liveRequired = recorder.liveRequiredFields && Object.keys(recorder.liveRequiredFields).some(liveLabel => {
          const normLive = normalizeText(liveLabel);
          return normLive === normField || normLive.includes(normField) || normField.includes(normLive);
        });
        if (liveRequired) {
          entry.required = true;
          entry.requiredSource = 'live-page-required';
        } else {
          // 2-4. Classifier (exact then contains)
          const cls = classifyOracleField(fieldName);
          if (cls.required !== undefined) {
            entry.required = cls.required;
            entry.requiredSource = cls.requiredSource;
          }
        }
        // 5. Heuristic fallback — only if nothing above resolved
        if (entry.required === undefined) {
          const ALWAYS_REQUIRED_PATTERN = /^(business unit|amount|date|number|quantity|unit price|line|type|ledger|currency|account|organization|department|supplier|customer|item)$/i;
          const LIKELY_REQUIRED_PATTERN = /\b(business unit|amount|date|quantity|unit price|distribution|ledger|currency|account|line type|line amount)\b/i;
          if (ALWAYS_REQUIRED_PATTERN.test(normField) || LIKELY_REQUIRED_PATTERN.test(normField)) {
            entry.required = true;
            entry.requiredSource = 'field-name-pattern';
          }
        }
      }
      // Apply date-select metadata if this entry was identified as a date picker click
      if (recorder._pendingDateSelect) {
        entry.action = recorder._pendingDateSelect.action;
        entry.dayValue = recorder._pendingDateSelect.dayValue;
        entry.monthOffset = recorder._pendingDateSelect.monthOffset;
        // Prefer the actual committed input value over the calendar-inferred date.
        // The input value is the real business truth — what ADF stored in the field.
        let fieldId = recorder._pendingDateSelect.targetFieldId;
        let committedInputValue = fieldId && recorder.dateInputValueMap && recorder.dateInputValueMap[fieldId];
        // Fallback: no targetFieldId on the gridcell → take any unclaimed date value from
        // dateInputValueMap. Oracle ADF fires a change event on the *input* whenever a
        // gridcell commits the date, so if a committed date string is sitting there, it
        // belongs to this date-select. The offset-based fullDate the picker-nav tracker
        // computed can drift (user navigated prev/next in ways we don't track perfectly),
        // so the committed input is always more trustworthy.
        if (!committedInputValue && recorder.dateInputValueMap) {
          if (!recorder._consumedDateFieldIds) recorder._consumedDateFieldIds = new Set();
          const datePattern = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
          for (const [fid, val] of Object.entries(recorder.dateInputValueMap)) {
            if (recorder._consumedDateFieldIds.has(fid)) continue;
            if (!datePattern.test(val || '')) continue;
            fieldId = fid;
            committedInputValue = val;
            recorder._consumedDateFieldIds.add(fid);
            console.log(`[recorder] Date: committed-input fallback (no targetFieldId on gridcell) → '${val}' (field ${fid})`);
            break;
          }
        }
        if (committedInputValue) {
          entry.originalValue = committedInputValue;
          entry.committedValue = committedInputValue;
          entry.displayValue = committedInputValue;
          console.log(`[recorder] Date: using committed input value '${committedInputValue}' (from field ${fieldId})`);
        } else {
          entry.originalValue = recorder._pendingDateSelect.originalValue;
          entry.displayValue = recorder._pendingDateSelect.displayValue;
        }
        entry.targetFieldId = fieldId || '';
        recorder._pendingDateSelect = null;
      }
      // Transfer raw SVG sub-selector captured during the collapse step so the
      // later navContext attachment pass can read it. Marker only; stripped from
      // the final action in pass 9b (moved into navContext.rawSubSelector).
      if (recorder._pendingRawSubSelector) {
        entry._rawSubSelector = recorder._pendingRawSubSelector;
        recorder._pendingRawSubSelector = null;
      }
      actions.push(entry);
    }

    // ── Post-processing ──
    if (actions.length > 1) {
      // Snapshot of parsed steps BEFORE any pass mutates them. Used by the
      // integrity check below to detect silent drops — if a step disappears
      // from the pipeline without a clear transformation trace (its locator,
      // value, or selector appearing in some surviving step), we warn so the
      // operator can investigate. Recorder pipeline contract: no silent loss.
      const parseSnapshot = actions.map(a => ({ code: a.code, type: a.type }));

      // 0b. Drop accidental keystroke noise that has no semantic effect on form state.
      //     Three patterns:
      //       (a) Modifier shortcuts: Control(OrMeta)+letter / Meta+letter /
      //           Alt+letter (Ctrl+C/A/V/X/Z, Cmd+C, etc.). Users hit these by
      //           reflex while focus is on a textbox; they're never load-bearing.
      //       (b) Toggle keys: CapsLock, NumLock, ScrollLock, Insert, Pause.
      //           These don't change form state — pure noise from accidental
      //           keypresses while a field is focused.
      //       (c) Cursor-positioning arrows (ArrowLeft/Right/Up/Down/Home/End)
      //           sandwiched between two .fill() calls on the same locator.
      //           Playwright's .fill() clears+retypes — cursor position is
      //           irrelevant once the next fill overwrites. The arrow press
      //           reliably trips strict-mode violations on replay because
      //           press() skips the actionability pipeline.
      //     Real example (Create Invoice → Line Amount = -1):
      //       fill('1') + ArrowLeft + fill('-1')   ← user typed 1, moved cursor, added '-'
      //     Pass 1's fill-dedup then collapses the two surviving fills.
      const MODIFIER_NOISE_RE = /\.press\(['"](?:Control(?:OrMeta)?|Meta|Alt)\+[a-zA-Z]['"]\)/;
      const TOGGLE_KEY_NOISE_RE = /\.press\(['"](?:CapsLock|NumLock|ScrollLock|Insert|Pause)['"]\)/;
      const CURSOR_NAV_KEYS_RE = /\.press\(['"](?:ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End)['"]\)/;
      const extractActionLocator = (c) => {
        const m = c.match(/^(.+?)\.(?:press|fill|click|selectOption|dispatchEvent|dblclick|hover|check|uncheck|focus|blur|pressSequentially)\(/);
        return m ? m[1] : null;
      };
      const noiseFiltered = [];
      for (let i = 0; i < actions.length; i++) {
        const cur = actions[i];
        if (!cur || !cur.code) { noiseFiltered.push(cur); continue; }
        if (MODIFIER_NOISE_RE.test(cur.code)) {
          console.log(`[recorder] Dropped modifier-shortcut noise: ${cur.code.substring(0, 100)}`);
          continue;
        }
        if (TOGGLE_KEY_NOISE_RE.test(cur.code)) {
          console.log(`[recorder] Dropped toggle-key noise: ${cur.code.substring(0, 100)}`);
          continue;
        }
        if (CURSOR_NAV_KEYS_RE.test(cur.code)) {
          const curLoc = extractActionLocator(cur.code);
          const prev = actions[i - 1];
          const next = actions[i + 1];
          if (curLoc && prev && next && prev.code && next.code &&
              prev.code.includes('.fill(') && next.code.includes('.fill(') &&
              extractActionLocator(prev.code) === curLoc &&
              extractActionLocator(next.code) === curLoc) {
            console.log(`[recorder] Dropped cursor-nav between fills: ${cur.code.substring(0, 100)}`);
            continue;
          }
        }
        noiseFiltered.push(cur);
      }
      actions.length = 0;
      noiseFiltered.forEach(a => actions.push(a));

      // 0c. Drop post-tab stale getByText clicks. Tight three-step pattern:
      //       i:   page.getByRole('combobox'|'textbox', ...).fill('X')
      //       i+1: SAME locator .press('Tab')
      //       i+2: page.getByText('X').click()
      //     ADF's typeahead suggestion popup closes when Tab commits the value,
      //     so the click on that popup text reliably times out at replay (30s).
      //     The value committed by Tab already matches the user's intent.
      //
      //     Safety constraints (to avoid dropping legitimate steps):
      //       (a) Strict adjacency — fill, Tab, getByText must be consecutive.
      //       (b) EXACT value match — the getByText argument must equal the
      //           prior fill value (case-insensitive, trimmed).
      //       (c) Same-locator Tab — the press('Tab') must be on the same
      //           combobox/textbox locator as the fill.
      const postTabStaleFiltered = [];
      let postTabStaleDropCount = 0;
      for (let i = 0; i < actions.length; i++) {
        const cur = actions[i];
        if (i >= 2 && cur && cur.code) {
          const textClick = cur.code.match(/^page\.getByText\(\s*['"]([^'"]+)['"]\s*\)\.click\(\)$/);
          if (textClick) {
            const clickedText = textClick[1].trim().toLowerCase();
            const prev1 = actions[i - 1];
            const prev2 = actions[i - 2];
            const tabMatch = prev1 && prev1.code && prev1.code.match(/^(page\.getByRole\(\s*['"](?:combobox|textbox)['"][^)]*\))\.press\(\s*['"]Tab['"]\s*\)$/);
            const fillMatch = prev2 && prev2.code && prev2.code.match(/^(page\.getByRole\(\s*['"](?:combobox|textbox)['"][^)]*\))\.fill\(\s*['"]([^'"]*)['"]\s*\)$/);
            if (tabMatch && fillMatch && tabMatch[1] === fillMatch[1] && fillMatch[2].trim().toLowerCase() === clickedText) {
              postTabStaleDropCount++;
              console.log(`[recorder] Dropped post-tab stale getByText click: '${textClick[1]}' (matches prior fill '${fillMatch[2]}' on same locator)`);
              continue;
            }
          }
        }
        postTabStaleFiltered.push(cur);
      }
      if (postTabStaleDropCount > 0) {
        console.log(`[recorder] Post-tab stale-click pass: ${postTabStaleDropCount} step(s) dropped`);
        actions.length = 0;
        postTabStaleFiltered.forEach(a => actions.push(a));
      }

      // 1. Fill dedup — collapse only redundant fill-then-fill on same field.
      //    Preserve click-before-fill transitions (opener/focus steps).
      const deduped = [];
      function fieldKey(code) {
        const m = code.match(/^(page\..+?)\.(?:click|fill|press|pressSequentially|selectOption)\(/);
        return m ? m[1] : null;
      }
      function isFill(code) { return /\.fill\(/.test(code) || /\.pressSequentially\(/.test(code); }

      for (let i = 0; i < actions.length; i++) {
        const curCode = actions[i].code;
        const key = fieldKey(curCode);
        if (!key) { deduped.push(actions[i]); continue; }
        // Only dedup if CURRENT step is a fill AND the NEXT step on same key is also a fill.
        // This preserves click→fill, press→fill, and other mixed transitions.
        if (isFill(curCode) && i + 1 < actions.length && fieldKey(actions[i + 1].code) === key && isFill(actions[i + 1].code)) {
          console.log(`[recorder] Fill dedup: dropped earlier fill on '${key.substring(0, 50)}'`);
          continue;
        }
        deduped.push(actions[i]);
      }

      // 1b. Consecutive identical click dedup — collapse duplicate clicks to 1.
      //     EXEMPT from dedup: navigation links, tiles, menu expanders, task panel actions.
      //     These may look like duplicates but the first click expands and second activates.
      //     Only dedup generic buttons (not Delete/Add which are intentionally repeated).
      const REPEATABLE_BUTTONS = /name:\s*'(?:Delete|Add)',?\s*(?:exact:\s*true)?/;
      // Tab-bar overflow scroll arrows (flat-tabs-overflow-left/right-svg) are intentionally
      // repeated — each click scrolls the tab strip one step to reveal the next hidden tab.
      // Resolution varies (720p needs more clicks than 1080p), so consecutive scrolls must survive.
      const NAV_PATTERNS = /#itemNode_|#clusters|getByRole\('link'|getByText\(|getByRole\('tab'|flat-tabs-overflow-(?:left|right)-svg/;
      const tileDeduped = [];
      for (let i = 0; i < deduped.length; i++) {
        const code = deduped[i].code;
        if (code.includes('.click()') && i < deduped.length - 1 && deduped[i + 1].code === code) {
          // Allow repeated Delete/Add clicks
          if (REPEATABLE_BUTTONS.test(code)) {
            tileDeduped.push(deduped[i]);
            continue;
          }
          // Preserve navigation clicks — first may expand, second may activate
          if (NAV_PATTERNS.test(code)) {
            tileDeduped.push(deduped[i]);
            continue;
          }
          console.log(`[recorder] Duplicate click dropped: ${code.substring(0, 70)}`);
          continue;
        }
        tileDeduped.push(deduped[i]);
      }
      deduped.length = 0;
      tileDeduped.forEach(a => deduped.push(a));

      // 1c. Label-click → selectOption collapse.
      //     Oracle ADF af:selectOneChoice: clicking the field label opens the dropdown,
      //     then clicking the value selects it. Playwright records:
      //       getByText('Business Unit').click()        ← label opens dropdown
      //       getByText('McGrath RentCorp').click()     ← value selected
      //     We collapse these two steps into one:
      //       getByLabel('Business Unit').selectOption({ label: 'McGrath RentCorp' })
      //     This is stable, readable, and works even if the user clicks the label instead of the arrow.
      const selectCollapsed = [];
      for (let i = 0; i < deduped.length; i++) {
        const cur = deduped[i];
        const next = deduped[i + 1];

        const labelClick = cur.code.match(/^page\.getByText\('([^']+)'\)\.click\(\)$/);
        if (labelClick && next) {
          const valueClick = next.code.match(/^page\.getByText\('([^']+)'\)(?:\.first\(\))?\.click\(\)$/);
          if (valueClick && valueClick[1] !== labelClick[1]) {
            // Collapse: label click + value click → selectOption
            const fieldName = labelClick[1];
            const value = valueClick[1];
            const collapsed = {
              ...cur,
              code: `page.getByLabel('${fieldName}').selectOption({ label: '${value}' })`,
              rawCode: `page.getByLabel('${fieldName}').selectOption({ label: '${value}' })`
            };
            // Carry required classification from field name
            const cls = classifyOracleField(fieldName);
            if (cls.required !== undefined) {
              collapsed.required = cls.required;
              collapsed.requiredSource = cls.requiredSource;
            }
            // Fallback: field-name-pattern heuristic (same as main loop)
            if (collapsed.required === undefined) {
              const ALWAYS_REQUIRED_PATTERN = /^(Business Unit|Amount|Date|Number|Quantity|Unit Price|Line|Type|Ledger|Currency|Account|Organization|Department|Supplier|Customer|Item)$/i;
              const LIKELY_REQUIRED_PATTERN = /\b(business unit|amount|date|quantity|unit price|distribution|ledger|currency|account|line type|line amount)\b/i;
              if (ALWAYS_REQUIRED_PATTERN.test(fieldName.trim()) || LIKELY_REQUIRED_PATTERN.test(fieldName.trim())) {
                collapsed.required = true;
                collapsed.requiredSource = 'field-name-pattern';
              }
            }
            selectCollapsed.push(collapsed);
            i++; // skip the value click — consumed
            continue;
          }
        }
        selectCollapsed.push(cur);
      }
      deduped.length = 0;
      selectCollapsed.forEach(a => deduped.push(a));

      // 1d. Oracle ADF inputComboboxListOfValues collapse.
      //     Pattern A (direct): user clicks ::btn → ADF auto-opens → user clicks a cell.
      //     Pattern B (search):  user clicks ::btn → types in search box → clicks a cell.
      //     Both collapse to ::content.fill(value) + Tab — avoids glass pane, phantom cells,
      //     and strict mode issues entirely by writing directly to the combobox input.
      //
      //     Pattern A:
      //       page.locator('[id$=":fcslov1:sis1:is1::btn"]').click()
      //       page.getByRole('gridcell', { name: 'McGrath RentCorp' }).click()
      //     Pattern B:
      //       page.locator('[id$=":fcslov1:sis1:is1::btn"]').click()
      //       page.getByRole('textbox', ...).fill('McGrath')       ← search step — consumed
      //       page.getByRole('gridcell', { name: 'McGrath RentCorp' }).click()
      //     Both become:
      //       page.locator('[id$=":fcslov1:sis1:is1::content"]').fill('McGrath RentCorp')
      //       page.locator('[id$=":fcslov1:sis1:is1::content"]').press('Tab')
      const lovCollapsed = [];
      for (let i = 0; i < deduped.length; i++) {
        const cur = deduped[i];

        const btnMatch = cur.code.match(/^page\.locator\(['"]\[id\$=["']([^"']+::btn)["']\]['"]\)\.click\(\)$/);
        if (btnMatch) {
          // Look ahead for a gridcell/cell click, skipping at most 3 intermediate steps
          // (search fill, press Enter, wait — typical of a search-then-select flow)
          let cellIdx = -1;
          for (let k = i + 1; k <= Math.min(i + 4, deduped.length - 1); k++) {
            const candidate = deduped[k].code;
            if (/^page\.getByRole\('(?:gridcell|cell)'/.test(candidate) && candidate.includes('.click()')) {
              cellIdx = k;
              break;
            }
            // Stop scanning if we hit something that is clearly NOT a LOV search step
            const isLovSearchStep =
              /\.fill\(/.test(candidate) ||
              /\.press\('Enter'\)/.test(candidate) ||
              /\.press\('Tab'\)/.test(candidate) ||
              /\.pressSequentially\(/.test(candidate) ||
              /getByRole\('(?:textbox|combobox)'/.test(candidate) ||
              /getByLabel\(/.test(candidate);
            if (!isLovSearchStep) break;
          }

          if (cellIdx !== -1) {
            const cellCode = deduped[cellIdx].code;
            const cellMatch = cellCode.match(/^page\.getByRole\('(?:gridcell|cell)',\s*\{\s*name:\s*'([^']+)'(?:,\s*exact:\s*true)?\s*\}\)\.click\(\)$/);
            if (cellMatch) {
              const btnIdSuffix = btnMatch[1]; // e.g. ":fcslov1:sis1:is1::btn"
              const contentIdSuffix = btnIdSuffix.replace(/::btn$/, '::content');
              const value = cellMatch[1];
              const contentSelector = `[id$="${contentIdSuffix}"]`;
              lovCollapsed.push({
                ...cur,
                code: `page.locator('${contentSelector}').fill('${value}')`,
                rawCode: `page.locator('${contentSelector}').fill('${value}')`
              });
              lovCollapsed.push({
                type: 'playwright-code',
                code: `page.locator('${contentSelector}').press('Tab')`,
                rawCode: `page.locator('${contentSelector}').press('Tab')`,
              });
              i = cellIdx; // consume btn + all intermediate steps + cell click
              continue;
            }
          }
        }
        lovCollapsed.push(cur);
      }
      deduped.length = 0;
      lovCollapsed.forEach(a => deduped.push(a));

      // 1d2. getByTitle('Search: X') LOV — no collapse needed.
      //      The replayer handles icon click → wait for cell → force click → OK natively.
      //      Keep all steps as recorded; do not drop anything between the icon click and the
      //      result cell — dropping intermediate steps has caused fields to go missing.

      // 1d3. Stale combobox press('Enter') → press('Tab') when the user moved
      //      to a different field (so Enter would have opened a search dialog
      //      they didn't want). EXCLUDES flexfield combos (Distribution /
      //      Combination / Account / GL) where Tab opens the segment editor
      //      popup; for those Enter is the correct commit.
      const FLEXFIELD_NAME_RE = /name:\s*'[^']*(?:Distribution|Combination|Account(?!\s+Number)|Charge\s+Account|GL\s+Account|Segment)/i;
      for (let i = 0; i < lovCollapsed.length; i++) {
        const cur = lovCollapsed[i];
        const pressEnter = cur.code.match(/^page\.getByRole\('combobox'[^)]*\)\.press\('Enter'\)$/);
        if (pressEnter && i > 0) {
          const prev = lovCollapsed[i - 1].code;
          const isComboFill = /^page\.getByRole\('combobox'[^)]*\)\.fill\(/.test(prev);
          if (isComboFill) {
            // Skip the rewrite if either the press or its preceding fill targets a flexfield combo.
            if (FLEXFIELD_NAME_RE.test(cur.code) || FLEXFIELD_NAME_RE.test(prev)) {
              continue;
            }
            const next = lovCollapsed[i + 1];
            const nextIsCellClick = next && /^page\.getByRole\('(?:gridcell|cell)'/.test(next.code) &&
              (next.code.includes('.click()') || next.code.includes('.dblclick()'));
            // Tab on table comboboxes creates a new empty row, so keep Enter before Save.
            const nextIsSave = next && /getByRole\('button',\s*\{\s*name:\s*'(?:Save|Submit|Done|Complete)/.test(next.code) &&
              next.code.includes('.click()');
            const nextIsComboFill = next && /^page\.getByRole\('combobox'[^)]*\)\.fill\(/.test(next.code);
            if (!nextIsCellClick && !nextIsSave && nextIsComboFill) {
              console.log(`[recorder] Stale combobox Enter → Tab: ${cur.code}`);
              cur.code = cur.code.replace("press('Enter')", "press('Tab')");
              cur.rawCode = cur.rawCode.replace("press('Enter')", "press('Tab')");
            }
          }
        }
      }

      // 1d3c. Flexfield segment-editor noise collapse.
      //       When a flexfield combo (Distribution Combination ID, Charge
      //       Account, etc.) is filled with the FULL dotted-numeric value,
      //       Oracle's segment-editor popup may still open on Tab. The user
      //       then clicks through MGRC COMPANY / MGRC DIVISION / etc. to
      //       reproduce the same value. Those segment-field interactions
      //       are pure noise — the original fill already has the full
      //       committed value. Drop them.
      const flexfieldNameRe = /getByRole\(\s*['"]combobox['"]\s*,\s*\{\s*name:\s*['"](?:[^'"]*Distribution[^'"]*Combination|[^'"]*Charge\s+Account|[^'"]*GL\s+Account|[^'"]*Combination\s+ID)[^'"]*['"]/i;
      const isFlexfieldStep = (a) => a && a.code && flexfieldNameRe.test(a.code);
      const isFullValueFlexfieldFill = (a) => {
        if (!isFlexfieldStep(a)) return false;
        const m = a.code.match(/\.fill\(['"]([^'"]+)['"]\)/);
        return !!m && /^\d+(?:\.\d+){3,}$/.test(m[1]);
      };
      const isFlexfieldPress = (a) =>
        isFlexfieldStep(a) && /\.press\(['"](?:Tab|Enter)['"]\)/.test(a.code);
      // Segment editor field: ALL-CAPS combobox/textbox name (≥2 words, e.g. 'MGRC COMPANY').
      const isSegmentInteraction = (a) =>
        a && a.code &&
        /getByRole\(\s*['"](?:combobox|textbox)['"]\s*,\s*\{\s*name:\s*['"][A-Z][A-Z0-9_]*(?:\s+[A-Z0-9][A-Z0-9_]*)+['"]/.test(a.code);
      // Segment editor's intermediate validation dialog OK button.
      const isSegmentDialogOk = (a) =>
        a && a.code &&
        /page\.locator\(\s*['"]\[id="d1::[^"]+"\]['"]\)\.getByRole\(\s*['"]button['"]\s*,\s*\{\s*name:\s*['"]OK['"]/.test(a.code);

      const segCollapsed = [];
      let segDropped = 0;
      for (let i = 0; i < lovCollapsed.length; ) {
        const cur = lovCollapsed[i];
        segCollapsed.push(cur);
        if (isFullValueFlexfieldFill(cur)) {
          // Keep the immediately-following Tab/Enter on the same flexfield.
          if (i + 1 < lovCollapsed.length && isFlexfieldPress(lovCollapsed[i + 1])) {
            segCollapsed.push(lovCollapsed[i + 1]);
            i += 2;
          } else {
            i++;
          }
          // Drop segment-field interactions and intermediate dialog OK clicks
          // until we hit a step that's clearly outside the segment editor.
          while (i < lovCollapsed.length &&
                 (isSegmentInteraction(lovCollapsed[i]) || isSegmentDialogOk(lovCollapsed[i]))) {
            console.log(`[recorder] Segment-editor noise dropped: ${(lovCollapsed[i].code || '').substring(0, 90)}`);
            segDropped++;
            i++;
          }
        } else {
          i++;
        }
      }
      if (segDropped > 0) {
        console.log(`[recorder] Flexfield segment-editor collapse: ${segDropped} step(s) dropped`);
        lovCollapsed.length = 0;
        lovCollapsed.push(...segCollapsed);
      }

      // NOTE: Search link dialog collapse (1d4) disabled — it was deleting working
      // navigation steps for Bill-to Name, Ship-to Name. All search dialog paths are
      // now preserved as recorded. The replayer handles them via self-heal.

      // 1d5. LOV → inline fill dedup.
      //      When a field was already set via getByTitle('Search: X') + cell click,
      //      drop any subsequent combobox('X').fill() + option('X').click() pair.
      //      This happens when the user interacts with the same field twice during
      //      recording (once via search icon, once by typing).
      const lovFieldsSet = new Set(); // Track fields set via LOV search
      for (let i = 0; i < lovCollapsed.length; i++) {
        const cur = lovCollapsed[i];
        // Track fields set via getByTitle('Search: X') — extract field name
        const titleSearch = cur.code.match(/getByTitle\('Search:\s*([^']+)'\)/);
        if (titleSearch) lovFieldsSet.add(titleSearch[1].trim().toLowerCase());
      }

      if (lovFieldsSet.size > 0) {
        const lovDeduped = [];
        for (let i = 0; i < lovCollapsed.length; i++) {
          const cur = lovCollapsed[i];
          // Check if this is a combobox fill for a field already set by LOV
          const comboFill = cur.code.match(/getByRole\('combobox',\s*\{\s*name:\s*'([^']+)'/);
          if (comboFill && /\.fill\(/.test(cur.code)) {
            const fieldName = comboFill[1].trim().toLowerCase();
            if (lovFieldsSet.has(fieldName)) {
              // Also skip the next step if it's an option click (the selection step)
              const next = lovCollapsed[i + 1];
              if (next && /getByRole\('option'/.test(next.code) && next.code.includes('.click()')) {
                console.log(`[recorder] LOV→inline dedup: dropped fill+option for '${comboFill[1]}' (already set by Search icon)`);
                i++; // skip option click too
                continue;
              }
              console.log(`[recorder] LOV→inline dedup: dropped fill for '${comboFill[1]}' (already set by Search icon)`);
              continue;
            }
          }
          lovDeduped.push(cur);
        }
        lovCollapsed.length = 0;
        lovDeduped.forEach(a => lovCollapsed.push(a));
      }

      // 1e. DISABLED — inline LOV collapse was producing `fill(full) + Tab` which, for
      //     Oracle ADF's af:inputComboboxListOfValues, does NOT commit the value. Tab
      //     triggers validation → opens the Search-and-Select modal → blocks next step.
      //     Keeping the original `combobox.fill('partial') + option.click('FullValue')`
      //     sequence instead — ADF commits cleanly when the option is clicked from the
      //     inline dropdown.

      // 1f. DISABLED — same reason as 1e. `combobox.fill(full) + Tab` does not commit on
      //     Oracle ADF LOV fields. Keeping the original `fill(partial) + press('Enter') +
      //     cell.click/dblclick` sequence — ADF's modal dialog commits reliably when the
      //     result row is clicked or double-clicked.

      // 1g. Drop getByText/getByRole('option') click after combobox.press('Tab').
      //     Tab already committed the value — the dropdown suggestion click is redundant.
      //     Without this, the replayer wastes 30s timing out on invisible dropdown text.
      const tabCleaned = [];
      let lastWasComboTab = false;
      for (let i = 0; i < lovCollapsed.length; i++) {
        const cur = lovCollapsed[i];
        if (lastWasComboTab) {
          // Drop getByText or option clicks that follow a Tab (dropdown already dismissed)
          const isDropdownClick = /^page\.getByText\(/.test(cur.code) && cur.code.includes('.click()');
          const isOptionClick = /^page\.getByRole\('option'/.test(cur.code) && cur.code.includes('.click()');
          if (isDropdownClick || isOptionClick) {
            console.log(`[recorder] Post-Tab noise dropped: ${cur.code.substring(0, 70)}`);
            lastWasComboTab = false;
            continue;
          }
          lastWasComboTab = false;
        }
        if (/getByRole\('combobox'[^)]*\)\.press\('Tab'\)/.test(cur.code)) {
          lastWasComboTab = true;
        }
        tabCleaned.push(cur);
      }
      lovCollapsed.length = 0;
      tabCleaned.forEach(a => lovCollapsed.push(a));

      // 1g2. Conditional press('Escape') injection after combobox option.click().
      //      ADF sometimes leaves a dropdown overlay visible after option pick,
      //      blocking subsequent top-level toolbar clicks (Save / Submit etc.).
      //      However, when the next recorded action is itself a click on
      //      another form field (textbox/combobox/etc.) inside the same dialog,
      //      injecting Escape harms more than it helps — Escape escalates to
      //      the modal dialog and closes the WHOLE form (verified 2026-05-07
      //      against Create Supplier flow on Tax Country pick).
      //
      //      Tightened condition: inject Escape ONLY when the next recorded
      //      action is a top-level finalize button (Save / Save and Close /
      //      Submit / Done / Apply / Create / Continue). Field-to-field
      //      flows skip the injection — the replayer's retry-with-force
      //      handles overlay edge cases for those.
      const TOOLBAR_FINALIZE_RE = /getByRole\(\s*['"]button['"]\s*,\s*\{\s*name:\s*['"](?:Save|Save\s+and\s+Close|Save\s+and\s+Create\s+Another|Submit|Done|Apply|Create|Continue|Complete)['"]/i;
      const overlayDismissed = [];
      for (let i = 0; i < lovCollapsed.length; i++) {
        const cur = lovCollapsed[i];
        overlayDismissed.push(cur);
        if (/getByRole\('option'/.test(cur.code) && (cur.code.includes('.click()') || cur.code.includes('.dblclick()'))) {
          const prev = overlayDismissed.length >= 2 ? overlayDismissed[overlayDismissed.length - 2] : null;
          if (!prev || !/getByRole\('combobox'[^)]*\)\.(?:fill|pressSequentially)\(/.test(prev.code)) continue;
          const next = lovCollapsed[i + 1];
          if (!next || !next.code || !TOOLBAR_FINALIZE_RE.test(next.code)) {
            console.log(`[recorder] Escape injection skipped (next step is not a finalize button): ${(next && next.code ? next.code.substring(0, 80) : '(end of script)')}`);
            continue;
          }
          const comboMatch = prev.code.match(/^(page\.getByRole\('combobox'[^)]*\))/);
          if (comboMatch) {
            overlayDismissed.push({
              type: 'playwright-code',
              code: `${comboMatch[1]}.press('Escape')`,
              rawCode: `${comboMatch[1]}.press('Escape')`
            });
            console.log(`[recorder] Injected Escape before finalize-button click to dismiss dropdown overlay`);
          }
        }
      }
      lovCollapsed.length = 0;
      overlayDismissed.forEach(a => lovCollapsed.push(a));

      // 1h. Drop row-navigation cell clicks between row-scoped fills.
      //     When the user switches between table rows (e.g. fills Unit Price for row 1,
      //     clicks Unit Price cell in row 2 to focus it, fills Unit Price for row 2),
      //     the cell click is just a focus change — not a meaningful action.
      //     Only drops cell.nth(N).click() when surrounded by row-scoped fills.
      //     SAFE: LOV result cell clicks (data values) never appear between row fills.
      function isRowScopedFill(code) {
        return /getByRole\('row'/.test(code) && /\.(?:fill|pressSequentially)\(/.test(code);
      }
      const rowNavCleaned = [];
      for (let i = 0; i < lovCollapsed.length; i++) {
        const cur = lovCollapsed[i];
        // Detect: cell.nth(N).click() between two row-scoped fills
        if (/getByRole\('cell'[^)]*\)\.nth\(\d+\)\.click\(\)/.test(cur.code)) {
          const prev = rowNavCleaned[rowNavCleaned.length - 1];
          const next = lovCollapsed[i + 1];
          if (prev && next && isRowScopedFill(prev.code) && isRowScopedFill(next.code)) {
            console.log(`[recorder] Row-nav noise dropped: ${cur.code.substring(0, 70)}`);
            continue;
          }
        }
        rowNavCleaned.push(cur);
      }
      lovCollapsed.length = 0;
      rowNavCleaned.forEach(a => lovCollapsed.push(a));

      // 3. Tag LOV result cell clicks — these are selections from a Search-and-Select
      //    dialog, NOT independent user inputs. The preceding combobox fill or
      //    getByTitle('Search: X') is the real parameter; the cell click just picks
      //    the result row. Tag with lovResult so parameterization skips them.
      function isCellClick(code) {
        // cell/gridcell role — canonical LOV result shape
        if (/^page\.getByRole\('(?:gridcell|cell)'/.test(code) &&
            (code.includes('.click()') || code.includes('.dblclick()'))) return true;
        // getByText(...).dblclick() — Playwright emits this when user double-clicks a
        // non-cell-role span inside a search result row (e.g. account number column).
        // The preceding-combobox-fill gate in the caller still prevents false positives.
        if (/^page\.getByText\(/.test(code) && code.includes('.dblclick()')) return true;
        return false;
      }

      // Sync `deduped` from `lovCollapsed`. Earlier passes (1d3c, 1d5, 1g)
      // rebuild `lovCollapsed` via `length = 0; push(...)`, which doesn't
      // propagate to `deduped` because the array reference changes. Object
      // mutations (Pass 1d3 Enter→Tab) propagate via shared references, but
      // drops do not. Without this sync, every drop those passes log is
      // silently undone — exactly the silent-loss bug we fix here.
      if (deduped.length !== lovCollapsed.length || deduped.some((a, i) => a !== lovCollapsed[i])) {
        const removed = deduped.length - lovCollapsed.length;
        if (removed !== 0) {
          console.log(`[recorder] deduped/lovCollapsed sync: ${removed > 0 ? removed + ' step(s) dropped' : 'array reordered'} since Pass 1d`);
        }
        deduped.length = 0;
        lovCollapsed.forEach(a => deduped.push(a));
      }

      const result = [];
      for (const a of deduped) {
        if (isCellClick(a.code)) {
          // Look back up to 4 preceding steps for a LOV opener pattern
          const lookback = result.slice(-4);
          for (let k = lookback.length - 1; k >= 0; k--) {
            const prev = lookback[k].code;
            // Pattern A: getByTitle('Search: X').click() — LOV search icon
            // ONLY tag lovResult if there was a preceding fill step (combobox.fill).
            // Without a fill, the user clicked the search icon and picked a value
            // directly (e.g. Distribution dialog) — the cell IS the parameter.
            if (/getByTitle\('Search:/.test(prev) && prev.includes('.click()')) {
              // Check if any earlier step in lookback is a fill
              let hasFill = false;
              for (let m = k - 1; m >= 0; m--) {
                if (/\.fill\(/.test(lookback[m].code)) { hasFill = true; break; }
              }
              if (hasFill) {
                a.lovResult = true;
                break;
              }
              // No fill before search icon → distribution-style pick, keep as regular click
            }
            // Pattern B: combobox.press('Enter') after combobox.fill() — search dialog
            if (/\.press\('Enter'\)/.test(prev)) {
              for (let m = k - 1; m >= 0; m--) {
                if (/getByRole\('combobox'[^)]*\)\.fill\(/.test(lookback[m].code)) {
                  a.lovResult = true;
                  break;
                }
              }
              if (a.lovResult) break;
            }
            // Pattern C: ::content.fill() + press('Tab') — LOV collapse output
            if (/::content["']\]?\)\.press\('Tab'\)/.test(prev)) {
              a.lovResult = true;
              break;
            }
          }
        }

        result.push(a);
      }

      // 4. Capture selectedValue on value-selection clicks (option, cell, getByText)
      //    so the parameterizer knows the actual selected value, not the search text.
      for (let i = 0; i < result.length; i++) {
        const a = result[i];
        const code = a.code;
        let selectedLabel = null;

        // Extract the displayed name from option clicks
        const optionMatch = code.match(/getByRole\('option',\s*\{\s*name:\s*'([^']+)'\s*(?:,\s*exact:\s*true)?\s*\}\).*\.click\(\)/);
        if (optionMatch) selectedLabel = optionMatch[1];

        // Extract from cell/gridcell clicks
        if (!selectedLabel) {
          const cellMatch = code.match(/getByRole\('(?:cell|gridcell)',\s*\{\s*name:\s*'([^']+)'\s*(?:,\s*exact:\s*true)?\s*\}\).*\.click\(\)/);
          if (cellMatch) selectedLabel = cellMatch[1];
        }

        // Extract from getByText clicks that follow a combobox fill
        if (!selectedLabel) {
          const textMatch = code.match(/getByText\('([^']+)'\).*\.click\(\)/);
          if (textMatch && i > 0) {
            // Only tag if preceded by a combobox fill (this is a value selection, not navigation)
            const prevSteps = result.slice(Math.max(0, i - 3), i);
            const hasFill = prevSteps.some(p => /getByRole\('combobox'[^)]*\)\.fill\(/.test(p.code));
            if (hasFill) selectedLabel = textMatch[1];
          }
        }

        if (selectedLabel && !a.selectedValue) {
          a.selectedValue = selectedLabel;
          a.selectedValueSource = code.includes('getByText(') ? 'text'
            : code.includes("getByRole('option'") ? 'option-name'
            : code.includes("getByRole('cell'") || code.includes("getByRole('gridcell'") ? 'cell-name'
            : 'unknown';
        }
      }

      // 5. Detect LOV search fills — combobox.fill() followed by Enter + cell/option click.
      //    Mark with isLovSearchFill so parameterizer uses selectedValue instead of fill text.
      for (let i = 0; i < result.length; i++) {
        const a = result[i];
        const comboFillMatch = a.code.match(/getByRole\('combobox',\s*\{\s*name:\s*'([^']+)'\s*\}\)\.fill\(/);
        if (!comboFillMatch) continue;
        const fieldName = comboFillMatch[1];

        // Check if preceded by Search/Select link click (getByTitle('Search: X') pattern)
        if (i > 0) {
          const prevSteps = result.slice(Math.max(0, i - 3), i);
          const hasSearchLink = prevSteps.some(p =>
            /getByTitle\('Search:/.test(p.code) && p.code.includes('.click()')
          );
          if (hasSearchLink) {
            a.isLovSearchFill = true;
            a.lovFieldName = fieldName;
            continue;
          }
        }

        // Check if followed by Enter + cell/option click (search dialog pattern)
        for (let j = i + 1; j <= Math.min(i + 4, result.length - 1); j++) {
          const step = result[j].code;
          if (/\.press\('Enter'\)/.test(step)) {
            // Look for cell or option click after Enter
            for (let k = j + 1; k <= Math.min(j + 3, result.length - 1); k++) {
              const after = result[k].code;
              if (isCellClick(after) || (/getByRole\('option'/.test(after) && after.includes('.click()'))) {
                a.isLovSearchFill = true;
                a.lovFieldName = fieldName;
                break;
              }
            }
            break;
          }
          // Also match direct option click without Enter (inline LOV dropdown)
          if (/getByRole\('option'/.test(step) && step.includes('.click()')) {
            // This is a normal combobox fill + option select — mark only if option value
            // differs from fill value (user typed partial search text)
            const fillValMatch = a.code.match(/\.fill\('([^']*)'\)/);
            const optValMatch = step.match(/getByRole\('option',\s*\{\s*name:\s*'([^']+)'/);
            if (fillValMatch && optValMatch) {
              const fillVal = fillValMatch[1].trim().toLowerCase();
              const optVal = optValMatch[1].trim().toLowerCase();
              if (fillVal !== optVal) {
                a.isLovSearchFill = true;
                a.lovFieldName = fieldName;
              }
            }
            break;
          }
          // Stop scanning if we hit an unrelated action
          if (/\.fill\(/.test(step) || /\.selectOption\(/.test(step)) break;
        }
      }

      // 7. Enrich combobox fill steps with the final selected value from the input field.
      //    After user types "JJ" and selects "J J Transport Inc.", the combobox input
      //    field gets the full name. Use comboboxValueMap to set selectedValue on the fill step.
      if (recorder.comboboxValueMap) {
        for (const a of result) {
          if (!a.code) continue;
          const comboFill = a.code.match(/getByRole\('combobox',\s*\{\s*name:\s*'([^']+)'/);
          if (comboFill && a.code.includes('.fill(')) {
            const fieldName = comboFill[1];
            const finalValue = recorder.comboboxValueMap[fieldName];
            if (finalValue) {
              a.selectedValue = finalValue;
              a.selectedValueSource = 'combobox-input';
              console.log(`[recorder] Combobox fill enriched: '${fieldName}' search='${a.code.match(/\.fill\('([^']*)'\)/)?.[1]}' → selected='${finalValue}'`);
            }
          }
        }
      }

      // 8. Apply committed (canonical) values from ADF change events and post-OK scans.
      //    committedValue is the final value ADF stored in the field — more accurate than
      //    selectedValue which comes from click target names. Parameterizer should prefer recorder.
      if (recorder.committedValueMap) {
        for (const a of result) {
          if (!a.code) continue;
          // Match combobox and textbox fill steps by field name
          const fieldMatch = a.code.match(/getByRole\('(?:combobox|textbox)',\s*\{\s*name:\s*'([^']+)'/);
          if (fieldMatch && a.code.includes('.fill(')) {
            const fieldName = fieldMatch[1];
            const committed = recorder.committedValueMap[fieldName];
            if (committed && committed !== a.selectedValue) {
              a.committedValue = committed;
              console.log(`[recorder] Committed value applied: '${fieldName}' → '${committed}'`);
            }
          }
        }
      }

      // 8b. Back-propagate LOV result cell name to the preceding combobox fill.
      //     Pattern: combobox.fill('ADF') → press('Enter') → cell('ADF International, Inc.').dblclick()
      //     where the cell has lovResult: true. The fill's selectedValue is the search
      //     text ("ADF"), but the canonical value committed to the field is the cell
      //     name ("ADF International, Inc."). Without this, Claude parameterizes the
      //     parameter value as "ADF" and the UI shows the truncated search text.
      for (let i = 0; i < result.length; i++) {
        const a = result[i];
        if (!a.code) continue;
        if (!/getByRole\('combobox'/.test(a.code)) continue;
        if (!a.code.includes('.fill(')) continue;
        if (a.committedValue) continue; // already set by block 8
        // Look ahead up to 4 steps for a lovResult cell/gridcell click
        for (let j = i + 1; j <= Math.min(i + 4, result.length - 1); j++) {
          const next = result[j];
          if (!next || !next.code) continue;
          // Stop scanning on another fill or unrelated field interaction
          if (/\.fill\(/.test(next.code) && j !== i + 1) break;
          if (!next.lovResult) continue;
          const cellMatch = next.code.match(/getByRole\('(?:cell|gridcell)',\s*\{\s*name:\s*'([^']+)'/);
          if (cellMatch) {
            a.committedValue = cellMatch[1];
            console.log(`[recorder] LOV back-propagate: combobox fill → committedValue='${cellMatch[1]}' from lovResult cell`);
          }
          break;
        }
      }

      // 8c. Option back-propagate — inline-dropdown LOV pattern.
      //     Pattern: combobox.fill('McGrath RentCorp') → getByRole('option', { name: 'McGrath RentCorp' }).click()
      //     No dialog, no OK, no dblclick — so blocks 8 / 8b don't trigger. The
      //     option name IS the canonical selection, but without this rule the
      //     fill only carries selectedValue. If Oracle normalizes/expands the
      //     final value (e.g. 'mcgrath' → 'McGrath RentCorp'), the option name
      //     is more reliable than the typed text. Narrow: only when no
      //     committedValue is already set, only for the immediate combobox+option
      //     pair (next step or within 2 steps).
      for (let i = 0; i < result.length; i++) {
        const a = result[i];
        if (!a.code) continue;
        if (!/getByRole\('combobox'/.test(a.code)) continue;
        if (!a.code.includes('.fill(')) continue;
        if (a.committedValue) continue; // don't overwrite blocks 8 / 8b
        for (let j = i + 1; j <= Math.min(i + 2, result.length - 1); j++) {
          const next = result[j];
          if (!next || !next.code) continue;
          if (/\.fill\(/.test(next.code)) break;
          const optMatch = next.code.match(/getByRole\('option',\s*\{\s*name:\s*'([^']+)'\s*\}\)/);
          if (optMatch && next.code.includes('.click()')) {
            a.committedValue = optMatch[1];
            console.log(`[recorder] Option back-propagate: combobox fill → committedValue='${optMatch[1]}' from option click`);
          }
          break;
        }
      }

      // 9. Apply committed values to LOV opener steps (search icon clicks, search link clicks).
      //    When a dialog LOV is used, the committed value from the target field applies
      //    to the step that opened the dialog — this covers distribution, BU, supplier, etc.
      //
      // Two-path priority:
      //   (a) Composite-picker family — openerCommittedMap[openerTitle] (keyed by
      //       exact opener title, populated via DOM-proximity binding in the
      //       runtime post-OK scan). This is authoritative because the value
      //       comes from the actual target input, not label-text matching.
      //   (b) Simple-LOV family — committedValueMap[fieldName] with exact
      //       normalized-equality match on the opener's field text. This is the
      //       existing path, preserved unchanged to avoid re-opening the "15"
      //       leak that broad fuzzy matching caused.
      // Path (a) wins when a binding fired; (b) is the fallback.
      if (recorder.committedValueMap || (recorder.openerCommittedMap && Object.keys(recorder.openerCommittedMap).length > 0)) {
        const normalizeFieldName = (s) => (s || '')
          .toLowerCase()
          .replace(/^\*+\s*/, '')
          .replace(/[:\s]+$/, '')
          .trim();
        const openerMap = recorder.openerCommittedMap || {};
        const fieldMap = recorder.committedValueMap || {};
        const applyOpenerMatch = (a, openerTitleFromCode, openerPhrase) => {
          // (a) Try composite-picker binding first. openerTitle in
          // openerCommittedMap has the literal "Search: X" or "Select: X" form.
          const openerKey = openerTitleFromCode;
          if (openerMap[openerKey]) {
            a.committedValue = openerMap[openerKey];
            if (!a.originalValue) a.originalValue = openerMap[openerKey];
            console.log(`[recorder] Composite-picker canonical: '${openerKey}' → '${openerMap[openerKey]}'`);
            return true;
          }
          // (a') Prefix match — the opener code text may be shorter than the full
          // binding-captured field name. Example: code says 'Select: Distribution'
          // but the DOM-proximity binding recorded 'Select: Distribution Combination ID'
          // (opener link text was truncated in the visible label). Match when a map
          // key starts with the opener-code text followed by a space.
          for (const key of Object.keys(openerMap)) {
            if (key === openerTitleFromCode) continue; // already tried
            if (key.startsWith(openerTitleFromCode + ' ')) {
              a.committedValue = openerMap[key];
              if (!a.originalValue) a.originalValue = openerMap[key];
              console.log(`[recorder] Composite-picker canonical (prefix): '${openerTitleFromCode}' → full key '${key}' → '${openerMap[key]}'`);
              return true;
            }
          }
          // (b) Simple-LOV exact label match
          const phrase = normalizeFieldName(openerPhrase);
          for (const [field, value] of Object.entries(fieldMap)) {
            if (normalizeFieldName(field) === phrase) {
              a.committedValue = value;
              if (!a.originalValue) a.originalValue = value;
              console.log(`[recorder] Simple-LOV canonical: '${phrase}' → '${value}'`);
              return true;
            }
          }
          return false;
        };
        for (let i = 0; i < result.length; i++) {
          const a = result[i];
          if (!a.code) continue;
          const searchByTitle = a.code.match(/getByTitle\('(Search:\s*[^']+)'\)/);
          const searchByLink = a.code.match(/getByRole\('link',\s*\{\s*name:\s*'(Search:\s*[^']+)'/);
          const selectByTitle = a.code.match(/getByTitle\('(Select:\s*[^']+)'\)/);
          const selectByLink = a.code.match(/getByRole\('link',\s*\{\s*name:\s*'(Select:\s*[^']+)'/);
          let openerTitleFromCode = null, openerPhrase = null;
          if (searchByTitle && a.code.includes('.click()')) {
            openerTitleFromCode = searchByTitle[1];
            openerPhrase = searchByTitle[1].replace(/^Search:\s*/i, '');
          } else if (searchByLink && a.code.includes('.click()')) {
            openerTitleFromCode = searchByLink[1];
            openerPhrase = searchByLink[1].replace(/^Search:\s*/i, '');
          } else if (selectByTitle && a.code.includes('.click()') && !a.committedValue) {
            openerTitleFromCode = selectByTitle[1];
            openerPhrase = selectByTitle[1].replace(/^Select:\s*/i, '');
          } else if (selectByLink && a.code.includes('.click()') && !a.committedValue) {
            openerTitleFromCode = selectByLink[1];
            openerPhrase = selectByLink[1].replace(/^Select:\s*/i, '');
          }
          if (openerTitleFromCode) {
            applyOpenerMatch(a, openerTitleFromCode, openerPhrase);
          }
        }
      }

      // 9b. Attach recorder-observed navigation metadata to #itemNode_* clicks.
      //     Runtime listener emitted __flowtrace_NAV_TILE_CLICK__ per click inside a
      //     nav tile; here we match each observation to its corresponding processed
      //     action. Strategy: tileId first (prefer observations whose tileId equals
      //     the step's tile id), FIFO second (consume in recording order within
      //     same tileId). rawSubSelector from the collapse pass is merged in.
      //     Compatibility: `code` is unchanged — metadata is additive.
      if (recorder.navTileClicks && recorder.navTileClicks.length > 0) {
        const claimed = new Set();
        for (const a of result) {
          if (!a || !a.code) continue;
          const tileMatch = a.code.match(/#(itemNode_[\w]+)/);
          if (!tileMatch) continue;
          const stepTileId = tileMatch[1];
          // Prefer the earliest unclaimed observation with matching tileId
          let idx = recorder.navTileClicks.findIndex((c, i) => !claimed.has(i) && c.tileId === stepTileId);
          if (idx === -1) {
            // Fallback: earliest unclaimed regardless of tileId (FIFO)
            idx = recorder.navTileClicks.findIndex((_, i) => !claimed.has(i));
          }
          if (idx === -1) break;
          const obs = recorder.navTileClicks[idx];
          claimed.add(idx);
          const hint = obs.navObservedExpansion ? 'expand' : (obs.afterMenuItems > 0 ? 'activate' : 'unknown');
          a.navContext = {
            tileId: obs.tileId,
            clickedTag: obs.clickedTag,
            pathIndex: obs.pathIndex,
            beforeMenuItems: obs.beforeMenuItems,
            afterMenuItems: obs.afterMenuItems,
            navObservedExpansion: obs.navObservedExpansion,
            childLabels: obs.childLabels || [],
            rawSubSelector: a._rawSubSelector || null
          };
          a.navActionHint = hint;
          delete a._rawSubSelector;
          console.log(`[recorder] Nav metadata attached: tile='${obs.tileId}' hint='${hint}' pathIndex=${obs.pathIndex} children=${(obs.childLabels||[]).length}`);
        }
      }

      // 10. Navigation state validator — flag #itemNode_ tile clicks that lack a
      //     preceding navigation context. Generalized: derives the expected module
      //     from the tile ID itself, no hardcoded module list.
      for (let i = 0; i < result.length; i++) {
        const a = result[i];
        if (!a.code) continue;
        const tileMatch = a.code.match(/#itemNode_(\w+)/);
        if (!tileMatch) continue;
        // Extract module root from tile ID: 'payables_payables_invoices' → 'payables'
        const tileId = tileMatch[1];
        const tileModule = tileId.split('_')[0];
        // Look back for ANY navigation action that could establish the module context:
        // - link click containing the module name (any casing)
        // - another #itemNode_ from the same module (already in context)
        // - #clusters navigation (module tab area)
        // - getByText click containing the module name (tab text click)
        let hasModuleNav = false;
        for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
          const prev = result[j].code || '';
          // Any link/text/tab click containing the module name (case-insensitive)
          const moduleRegex = new RegExp(tileModule.replace(/_/g, '[_ ]'), 'i');
          if (prev.includes('.click()') && moduleRegex.test(prev) && !prev.includes('#itemNode_')) {
            hasModuleNav = true; break;
          }
          // Another tile from the same module family (already navigated there)
          if (prev.includes(`#itemNode_${tileModule}`)) {
            hasModuleNav = true; break;
          }
          // #clusters navigation (Oracle Home module tab area)
          if (prev.includes('#clusters')) {
            hasModuleNav = true; break;
          }
          // Login/Home steps don't count — stop scanning past them
          if (prev.includes('Sign In') || prev.includes("name: 'Home'")) break;
        }
        if (!hasModuleNav) {
          a.navigationWarning = `Tile #itemNode_${tileId} may need a preceding module navigation step. On fresh sessions, the ${tileModule} module tab may not be visible.`;
          console.log(`[recorder] Navigation warning: #itemNode_${tileId} has no preceding ${tileModule} module navigation`);
        }
      }

      // 11. Date-picker collapse → [click textbox] + [fill(displayValue)] + [press Tab].
      //     (a) Textbox-click anchor — preferred: lookback finds the Date textbox click.
      //     (b) Icon-only fallback — anchor on `[id="<targetFieldId>"]` (captured
      //         by the runtime listener on the gridcell) and drop calendar-nav steps.
      //     Tab commits via blur — ADF accepts the date string directly.
      const esc = (s) => String(s == null ? '' : s).replace(/'/g, "\\'");
      const dateCollapsed = [];
      for (let di = 0; di < result.length; di++) {
        const cur = result[di];
        if (cur && cur.action === 'date-select' && cur.displayValue) {
          let anchorIdx = -1;
          let selectorPrefix = null;
          // Strategy (a): textbox-click anchor lookback (up to 10 steps).
          for (let j = dateCollapsed.length - 1; j >= Math.max(0, dateCollapsed.length - 10); j--) {
            const prev = dateCollapsed[j];
            if (!prev || !prev.code) continue;
            const mTextbox = prev.code.match(/^(page\.getByRole\('textbox',\s*\{\s*name:\s*'([^']*)'[^)]*\}\))\.click\(\)$/);
            if (mTextbox && /\bdate\b/i.test(mTextbox[2])) {
              anchorIdx = j;
              selectorPrefix = mTextbox[1];
              break;
            }
          }

          // Strategy (b): icon-only fallback via gridcell's targetFieldId.
          if (anchorIdx === -1 && cur.targetFieldId) {
            let dropFromIdx = dateCollapsed.length;
            for (let j = dateCollapsed.length - 1; j >= Math.max(0, dateCollapsed.length - 6); j--) {
              const prev = dateCollapsed[j];
              if (!prev || !prev.code) break;
              if (/getByTitle\('Select Date'\)/.test(prev.code) ||
                  /getByRole\('button',\s*\{\s*name:\s*'(?:Previous|Next) Month'/.test(prev.code) ||
                  /getByRole\('combobox',\s*\{\s*name:\s*'Year'/.test(prev.code)) {
                dropFromIdx = j;
                continue;
              }
              break;
            }
            anchorIdx = dropFromIdx - 1; // -1 is fine → length set to 0
            const targetId = String(cur.targetFieldId).replace(/'/g, "\\'").replace(/"/g, '\\"');
            selectorPrefix = `page.locator('[id="${targetId}"]')`;
            console.log(`[recorder] Date collapse (icon-only flow): targetFieldId='${targetId}', dropping ${dateCollapsed.length - dropFromIdx} calendar-nav step(s)`);
          }

          if (selectorPrefix) {
            dateCollapsed.length = anchorIdx + 1; // truncate preceding nav clicks
            const displayValue = cur.displayValue;
            const fillStep = {
              type: 'playwright-code',
              code: `${selectorPrefix}.fill('${esc(displayValue)}')`,
              rawCode: `${selectorPrefix}.fill('${esc(displayValue)}')`,
              committedValue: displayValue,
              originalValue: displayValue,
            };
            const pressStep = {
              type: 'playwright-code',
              code: `${selectorPrefix}.press('Tab')`,
              rawCode: `${selectorPrefix}.press('Tab')`,
            };
            if (cur.required !== undefined) {
              fillStep.required = cur.required;
              pressStep.required = cur.required;
            }
            dateCollapsed.push(fillStep, pressStep);
            console.log(`[recorder] Date collapsed: ${selectorPrefix} → fill('${displayValue}') + Tab`);
            continue;
          }
        }
        dateCollapsed.push(cur);
      }
      result.length = 0;
      dateCollapsed.forEach(a => result.push(a));

      // 12. LOV opener dialog collapse — FAMILY rule (not per-field).
      //     Covers all four opener variants uniformly:
      //       (i)   getByRole('link',   { name: 'Select: X' }).click()
      //       (ii)  getByRole('link',   { name: 'Search: X' }).click()
      //       (iii) getByTitle('Select: X').click()
      //       (iv)  getByTitle('Search: X').click()   ← Bill-to Name magnifier, etc.
      //     All four trigger a Search/Select dialog. The dialog is noisy at replay
      //     (row locators drift, Search button state races with result rendering),
      //     so we bypass it by filling the target textbox directly with the
      //     canonical value captured via DOM-proximity binding at record time.
      //
      //     Pattern: [opener (has committedValue)] → [any in-dialog steps] → [OK]
      //     Collapses to: [click target textbox] → [fill(canonical)] → [press Tab]
      //
      //     Tab, not Enter — Oracle editable grid rows advance on Enter, causing
      //     Save to validate untouched rows. Tab commits via blur and keeps focus.
      //
      //     Field-name resolution: opener text in the code may be shorter than the
      //     full binding key (e.g. code 'Select: Distribution' vs binding
      //     'Select: Distribution Combination ID'). openerCommittedMap is the
      //     source of truth; we prefix-match against it.
      const isLovOpener = (code) => {
        if (!code || !code.includes('.click()')) return false;
        return (
          /getByRole\('link',\s*\{\s*name:\s*'(?:Select|Search):\s*[^']+'/.test(code) ||
          /getByTitle\('(?:Select|Search):\s*[^']+'/.test(code)
        );
      };
      const isOkButtonClick = (code) =>
        /getByRole\('button',\s*\{\s*name:\s*'OK'/.test(code || '') &&
        (code || '').includes('.click()');
      const isComboboxStep = (code) => /getByRole\('combobox'/.test(code || '');
      const lovOpenerMap = (this && recorder.openerCommittedMap) || {};
      const liveRequiredFields = recorder.liveRequiredFields || {};

      // Helper: build [click textbox, fill(canonical), press Tab] for an opener step.
      // Returns null if we can't resolve a field name + canonical.
      const makeOpenerFillTriple = (openerStep) => {
        if (!openerStep || !openerStep.code || !openerStep.committedValue) return null;
        let openerPhrase = null, openerPrefix = null;
        let m = openerStep.code.match(/name:\s*'(Select|Search):\s*([^']+)'/);
        if (m) { openerPrefix = m[1]; openerPhrase = m[2].trim(); }
        if (!openerPhrase) {
          m = openerStep.code.match(/getByTitle\('(Select|Search):\s*([^']+)'/);
          if (m) { openerPrefix = m[1]; openerPhrase = m[2].trim(); }
        }
        if (!openerPhrase) return null;

        // Resolve full field name via openerCommittedMap (handles short prefix → full key)
        let resolvedFieldName = openerPhrase;
        for (const key of Object.keys(lovOpenerMap)) {
          if (lovOpenerMap[key] !== openerStep.committedValue) continue;
          const keyField = key.replace(/^(Select|Search):\s*/i, '').trim();
          if (keyField === openerPhrase || keyField.startsWith(openerPhrase + ' ')) {
            resolvedFieldName = keyField;
            break;
          }
        }
        if (!resolvedFieldName) return null;

        const canonical = openerStep.committedValue;
        // Pass 12 collapses LOV opener flows ('Search:'/'Select:' prefix).
        // The target input has TWO possible accessibility roles depending on
        // which Oracle ADF widget is behind the LOV:
        //
        //   (a) inputComboboxListOfValues — Transaction Source, Transaction
        //       Type, Bill-to Name, Supplier, Business Unit, etc. The inner
        //       input carries an explicit role='combobox'. (e62e10c, 2026-05-04)
        //   (b) Key flexfield / inputListOfValues — Distribution Combination
        //       ID, Charge Account, GL Account, etc. The inner input is a
        //       plain <input type="text"> with NO role attribute → Playwright's
        //       implicit role is 'textbox'. (verified live 2026-05-09 via MCP)
        //
        // Hardcoding either single role caused the other case to time out 30s
        // at replay. We use Playwright's .or() chaining so the locator matches
        // whichever role resolves at replay time — both cases work, no slow
        // self-heal needed.
        const targetSel = `page.getByRole('combobox', { name: '${esc(resolvedFieldName)}' }).or(page.getByRole('textbox', { name: '${esc(resolvedFieldName)}' })).first()`;

        // Required-flag re-derivation from the resolved field name
        let resolvedRequired;
        const normField = resolvedFieldName.toLowerCase().trim();
        const liveReq = Object.keys(liveRequiredFields).some((liveLabel) => {
          const normLive = (liveLabel || '').toLowerCase().trim();
          return normLive === normField || normLive.includes(normField) || normField.includes(normLive);
        });
        if (liveReq) {
          resolvedRequired = true;
        } else {
          try {
            const cls = classifyOracleField(resolvedFieldName);
            if (cls && cls.required !== undefined) resolvedRequired = cls.required;
          } catch (_) {}
          if (resolvedRequired === undefined) {
            const ALWAYS = /^(business unit|amount|date|number|quantity|unit price|line|type|ledger|currency|account|organization|department|supplier|customer|item|distribution combination id)$/i;
            const LIKELY = /\b(business unit|amount|date|quantity|unit price|distribution|ledger|currency|account|line type|line amount)\b/i;
            if (ALWAYS.test(normField) || LIKELY.test(normField)) resolvedRequired = true;
          }
        }

        const clickStep = { type: 'playwright-code', code: `${targetSel}.click()`, rawCode: `${targetSel}.click()` };
        const fillStep = {
          type: 'playwright-code',
          code: `${targetSel}.fill('${esc(canonical)}')`,
          rawCode: `${targetSel}.fill('${esc(canonical)}')`,
          committedValue: canonical,
          originalValue: canonical,
        };
        // Commit with Tab, not Enter. In Oracle Fusion editable grid rows (Lines
        // table, sub-tables), Enter on a cell advances to the next row — any
        // subsequent Save then validates the newly-touched empty row and fails
        // ('A selection is required'). Tab commits via blur, keeps focus.
        const pressStep = { type: 'playwright-code', code: `${targetSel}.press('Tab')`, rawCode: `${targetSel}.press('Tab')` };
        if (resolvedRequired !== undefined) {
          clickStep.required = resolvedRequired;
          fillStep.required = resolvedRequired;
          pressStep.required = resolvedRequired;
        }
        console.log(`[recorder] LOV opener emitted: '${openerPrefix || 'Select'}: ${openerPhrase}' → ${resolvedFieldName} = '${canonical}'`);
        return [clickStep, fillStep, pressStep];
      };

      // Multi-opener range collapse. Within [opener, OK]:
      //   • Each LOV opener with committedValue → emit fill triple
      //   • Each combobox click/fill (with or without committedValue) → preserve
      //     (Pass 13 will substitute the typed value with the canonical via
      //     committedValue back-propagated by Pass 8b)
      //   • Everything else (in-dialog cell clicks, Search buttons, OK) → drop
      // Handles the Receivables Create Transaction flow where the user fills
      // Transaction Source + Transaction Type + Bill-to Name through dialogs
      // that share a single trailing OK click. Old single-opener code dropped
      // Type and Bill-to Name as if they were Source's dialog steps.
      //
      // Foreign-interaction guard: the OK that closes an LOV dialog must come
      // before the user starts editing other form fields. Without this guard
      // a 25-step lookahead would match the end-of-flow Save-and-Close
      // confirmation OK and silently consume Transaction Number, line-item
      // fields, Save buttons — every required step in between.
      const isForeignInteraction = (code) => {
        if (!code) return false;
        // Line-item table row/label edits — never inside an LOV dialog
        if (/getByRole\('row',\s*\{[^}]*name:[^}]*Line Item/i.test(code)) return true;
        if (/getByLabel\('(?:Description|Quantity|Unit Price|Tax|Amount|Account|Memo|Comment)/i.test(code)) return true;
        // Save group — definite end of the create flow
        if (/getByRole\('button',\s*\{\s*name:\s*'Save(?:\s|')/.test(code)) return true;
        if (/getByTitle\('Save'\)/.test(code)) return true;
        if (/getByText\('Save and Close/.test(code)) return true;
        // Plain textbox interactions are on form fields, not LOV dialog inputs
        // (Oracle ADF dialog inputs use role='combobox', never role='textbox')
        if (/getByRole\('textbox',\s*\{\s*name:/.test(code) &&
            (code.includes('.click()') || code.includes('.fill('))) return true;
        return false;
      };

      const lovDialogCollapsed = [];
      let li = 0;
      while (li < result.length) {
        const a = result[li];
        if (a && a.code && isLovOpener(a.code) && a.committedValue) {
          // Tightened from 25 → 12. With the foreign-interaction guard below
          // this is plenty for the multi-opener flow (3 openers + cells + OK ≈ 7-10 steps).
          const windowEnd = Math.min(li + 12, result.length - 1);
          let okIdx = -1;
          for (let j = li + 1; j <= windowEnd; j++) {
            const stepCode = result[j] && result[j].code;
            if (!stepCode) continue;
            if (isForeignInteraction(stepCode)) break;
            if (isOkButtonClick(stepCode)) { okIdx = j; break; }
          }
          if (okIdx !== -1) {
            const emissions = [];
            let openersEmitted = 0, comboboxKept = 0;
            const droppedCodes = [];
            for (let k = li; k <= okIdx; k++) {
              const step = result[k];
              if (!step || !step.code) continue;
              if (isLovOpener(step.code) && step.committedValue) {
                const triple = makeOpenerFillTriple(step);
                if (triple) {
                  emissions.push(...triple);
                  openersEmitted++;
                } else {
                  droppedCodes.push(step.code);
                }
                continue;
              }
              if (isComboboxStep(step.code)) {
                emissions.push(step);
                comboboxKept++;
                continue;
              }
              droppedCodes.push(step.code);
            }
            if (emissions.length > 0) {
              lovDialogCollapsed.push(...emissions);
              console.log(`[recorder] LOV range collapsed [${li}-${okIdx}]: ${openersEmitted} opener(s) emitted, ${comboboxKept} combobox step(s) preserved, ${droppedCodes.length} step(s) dropped`);
              for (const dc of droppedCodes) {
                console.log(`[recorder]   dropped: ${dc.substring(0, 100)}`);
              }
              li = okIdx + 1;
              continue;
            }
          }
          // No trailing OK in tight window — emit the canonical-fill triple
          // in place of the opener click. Drop only the immediately-following
          // lovResult-tagged or cell/option click that picked the canonical.
          // Every other downstream step is preserved.
          const triple = makeOpenerFillTriple(a);
          if (triple) {
            lovDialogCollapsed.push(...triple);
            const next = result[li + 1];
            const nextIsLovPick = next && next.code && (
              next.lovResult === true ||
              /getByRole\('(?:cell|gridcell)'/.test(next.code) ||
              (/getByRole\('option'/.test(next.code) && next.code.includes('.click()')) ||
              (/getByText\(/.test(next.code) && next.code.includes('.dblclick()'))
            );
            if (nextIsLovPick) {
              console.log(`[recorder] LOV opener-only collapse: dropped pick step '${(next.code).substring(0, 100)}'`);
              li += 2;
            } else {
              li += 1;
            }
            continue;
          }
        }
        lovDialogCollapsed.push(a);
        li++;
      }
      result.length = 0;
      lovDialogCollapsed.forEach(a => result.push(a));

      // 13. Fill-value substitution.
      //     When a recorded fill('typed') has a committedValue that differs from the typed
      //     text, rewrite the `code` field so replay directly fills the final value (e.g.
      //     user typed 'J J' and ADF committed 'J J Transport Inc.' — we rewrite code to
      //     fill('J J Transport Inc.'), so the UI shows the real value on first render and
      //     downstream LOV auto-selection races become irrelevant).
      //     `rawCode` is preserved with the original typed value — the parameterizer still
      //     needs it to identify the step and extract the user's original intent.
      //
      //     EXCEPTION: when the next step is an option/cell click that picks an LOV result,
      //     skip substitution. Typing the full committed value into the combobox can either
      //     auto-commit the value (closing the dropdown before the option click) or fail to
      //     filter the dropdown to the recorded option name. Keeping the partial typed text
      //     preserves the autocomplete-then-pick flow that the recording captured.
      for (let ri = 0; ri < result.length; ri++) {
        const a = result[ri];
        if (!a || !a.code) continue;
        const fillMatch = a.code.match(/^(.+)\.fill\('([^']*)'\)$/);
        if (!fillMatch) continue;
        const prefix = fillMatch[1];
        const typedVal = fillMatch[2];
        if (!a.committedValue || a.committedValue === typedVal) continue;

        // Look ahead: is the next non-skipped step an option/cell click? If so, the
        // substitution would break the autocomplete-then-pick flow.
        let hasFollowingPick = false;
        for (let rj = ri + 1; rj < Math.min(result.length, ri + 4); rj++) {
          const next = result[rj];
          if (!next || !next.code || next.skipInReport) continue;
          const isOptionClick = /getByRole\('option'/.test(next.code) && next.code.includes('.click(');
          const isCellPickClick = /getByRole\('(?:cell|gridcell)'/.test(next.code) &&
                                  (next.code.includes('.click(') || next.code.includes('.dblclick('));
          if (isOptionClick || isCellPickClick || next.lovResult === true) {
            hasFollowingPick = true;
          }
          // Stop scanning past the next real action
          break;
        }

        if (hasFollowingPick) {
          console.log(`[recorder] Fill substitution skipped (followed by option/cell pick): '${typedVal}' kept as typed`);
          continue;
        }

        a.code = `${prefix}.fill('${esc(a.committedValue)}')`;
        console.log(`[recorder] Fill substituted: '${typedVal}' → '${a.committedValue}' (rawCode preserved)`);
      }

      // 14. Checkbox click rewrite → .check()/.uncheck(). Walks click
      //     actions and `recorder.checkboxToggles` (captured in fire order by
      //     the init-script listener) together; rewrites matching pairs so
      //     the parameterizer sees an unambiguous boolean. rawCode preserved.
      if (recorder.checkboxToggles && recorder.checkboxToggles.length > 0) {
        const normalize = (s) => String(s || '').toLowerCase()
          .replace(/^\**\s*/, '').replace(/[*:_]+/g, ' ').replace(/\s+/g, ' ').trim();
        let toggleIdx = 0;
        for (const a of result) {
          if (toggleIdx >= recorder.checkboxToggles.length) break;
          if (!a || !a.code || !a.code.endsWith('.click()')) continue;
          const m = a.code.match(/^page\.getByText\('([^']+)'\)\.click\(\)$/)
                 || a.code.match(/^page\.getByLabel\('([^']+)'\)\.click\(\)$/)
                 || a.code.match(/^page\.getByRole\(\s*['"](?:checkbox|cell|link)['"]\s*,\s*\{[^}]*name:\s*'([^']+)'[^}]*\}\s*\)\.click\(\)$/);
          if (!m) continue;
          const candidateLabel = m[1];
          const toggle = recorder.checkboxToggles[toggleIdx];
          const candNorm = normalize(candidateLabel);
          const togNorm = normalize(toggle.label);
          // Equal or contains-either (ADF labels sometimes carry trailing "(required)" etc.)
          const matches = candNorm === togNorm
                       || (candNorm.length > 0 && togNorm.includes(candNorm))
                       || (togNorm.length > 0 && candNorm.includes(togNorm));
          if (!matches) continue;
          const escLabel = toggle.label.replace(/'/g, "\\'");
          const action = toggle.newChecked ? 'check' : 'uncheck';
          a.code = `page.getByRole('checkbox', { name: '${escLabel}' }).${action}()`;
          a.isCheckbox = true;
          a.checkboxLabel = toggle.label;
          a.checkboxNewState = toggle.newChecked;
          console.log(`[recorder] Checkbox rewrite: '${candidateLabel}' → .${action}() (rawCode preserved)`);
          toggleIdx++;
        }
      }

      // 14b. Grid-cell commit-via-Tab insertion.
      //      When a `getByRole('cell',...).getByLabel(X).fill(...)` step in
      //      a Lines table is followed by a click on a DIFFERENT field, the
      //      Amount/Quantity/etc. cell stays in edit mode on replay (no
      //      natural focus blur). Adjacent column controls don't render
      //      until the previous cell commits. Insert a Tab to force the
      //      commit before the next click.
      //
      //      Emit `page.keyboard.press('Tab')` (focus-anchored), NOT
      //      `cell.getByLabel(X).press('Tab')` (selector-anchored). Oracle
      //      Fusion Lines tables resolve `getByRole('cell', { name: 'Amount',
      //      exact: true }).getByLabel('Amount')` to multiple cells (column
      //      header + each data row share the same accessible name), tripping
      //      strict-mode and timing out on press(). After .fill(), focus is
      //      on the just-filled input — keyboard.press fires Tab on the right
      //      element with no selector resolution at all.
      const isGridCellFill = (a) =>
        a && a.code && /^page\.getByRole\(\s*['"]cell['"]\s*,\s*\{[^}]+\}\s*\)\.getByLabel\(\s*['"][^'"]+['"]\s*\)\.fill\(/.test(a.code);
      const isNextFieldClick = (a) => {
        if (!a || !a.code) return false;
        // Combobox/textbox click on a NAMED field (e.g. Distribution Combination ID)
        if (/^page\.getByRole\(\s*['"](?:combobox|textbox)['"]\s*,\s*\{\s*name:/.test(a.code) && a.code.endsWith('.click()')) return true;
        // Or another cell click in the same grid
        if (/^page\.getByRole\(\s*['"]cell['"]\s*,\s*\{[^}]+\}\s*\)\.getByLabel\(/.test(a.code) && a.code.endsWith('.click()')) return true;
        return false;
      };
      const gridCommitOut = [];
      let gridCommitCount = 0;
      const keyboardTabCode = `page.keyboard.press('Tab')`;
      for (let i = 0; i < result.length; i++) {
        gridCommitOut.push(result[i]);
        if (isGridCellFill(result[i]) && i + 1 < result.length && isNextFieldClick(result[i + 1])) {
          const tabStep = {
            type: 'playwright-code',
            code: keyboardTabCode,
            rawCode: keyboardTabCode,
          };
          if (result[i].required !== undefined) tabStep.required = result[i].required;
          gridCommitOut.push(tabStep);
          gridCommitCount++;
          console.log(`[recorder] Grid-cell commit Tab (keyboard.press) inserted after: ${result[i].code.substring(0, 90)}`);
        }
      }
      if (gridCommitCount > 0) {
        console.log(`[recorder] Grid-cell commit pass: ${gridCommitCount} Tab press(es) inserted`);
        result.length = 0;
        result.push(...gridCommitOut);
      }

      // 15. JSON slim-down — drop write-only fields no downstream consumer reads.
      for (const a of result) {
        if (!a) continue;
        delete a.requiredSource;
        delete a.selectedValue;
        delete a.selectedValueSource;
      }

      // 16. Pipeline integrity check.
      //     Every parsed step (from parseSnapshot) must be either:
      //       (a) preserved verbatim — same code in result
      //       (b) transformed — its meaningful TOKENS (locator name, fill
      //           value, cell name, title text) appear in a result step.
      //           Dedup/collapse/rewrite passes legitimately rewrite the
      //           code but always preserve at least the field name or value.
      //     Anything else is a silent drop. This is the safety net that
      //     catches bugs in any current or future recorder pass.
      //
      //     Recorder pipeline contract: no silent loss. Every drop should
      //     be visible either as a logged drop or as a transformation
      //     trace (token survival in some output step).
      try {
        const outCodes = new Set(result.map(a => a && a.code).filter(Boolean));
        const outConcat = result.map(a => (a && a.code) || '').join('\n');
        // Pull every meaningful token from a code line. Each regex runs
        // independently so positional + named args both contribute (e.g.
        // `getByRole('cell', { name: 'X' })` yields BOTH 'cell' and 'X').
        const extractTokens = (code) => {
          if (!code) return [];
          const tokens = new Set();
          let m;
          // .fill('X') / .selectOption('X') / .selectOption({label/value: 'X'}) / .press('X')
          const valueRe = /\.(?:fill|selectOption|press|pressSequentially)\(\s*\{?\s*(?:label|value)?\s*:?\s*['"]([^'"]+)['"]/g;
          while ((m = valueRe.exec(code)) !== null) tokens.add(m[1]);
          // getByX('text-or-name')
          const positionalRe = /getBy\w+\(\s*['"]([^'"]+)['"]/g;
          while ((m = positionalRe.exec(code)) !== null) tokens.add(m[1]);
          // { name: 'X' } / { text: 'X' } anywhere
          const namedArgRe = /\b(?:name|text)\s*:\s*['"]([^'"]+)['"]/g;
          while ((m = namedArgRe.exec(code)) !== null) tokens.add(m[1]);
          // locator('selector')
          const locatorRe = /locator\(\s*['"]([^'"]+)['"]/g;
          while ((m = locatorRe.exec(code)) !== null) tokens.add(m[1]);
          return [...tokens].filter(t => t && t.length >= 3);
        };
        // Does any meaningful fragment of an input token survive in output?
        // Direct substring OR any 4+-char word (after splitting on ":/_/-"
        // separators) that appears in some output step.
        const tokenSurvives = (token, outText) => {
          if (outText.includes(token)) return true;
          const fragments = token.split(/[\s:_\-]+/).filter(f => f.length >= 4);
          return fragments.some(f => outText.includes(f));
        };
        // Generic dialog-dismissal buttons (OK / Yes / No / Cancel / Close / Done /
        // Apply / Search / Reset) are commonly consumed by collapse passes (LOV
        // opener, segment editor, etc.). They carry no meaningful field-data,
        // so a "missing transformation trace" warning would be a false positive.
        const isGenericDialogClick = (code) =>
          /^page\.getByRole\(\s*['"]button['"]\s*,\s*\{\s*name:\s*['"](?:OK|Ok|Yes|No|Cancel|Close|Done|Apply|Search|Reset|Continue)['"]/i.test(code) &&
          code.endsWith('.click()');
        const silentDrops = [];
        for (const snap of parseSnapshot) {
          if (!snap.code) continue;
          if (snap.code === '})()' || snap.code.startsWith('(async')) continue;
          if (outCodes.has(snap.code)) continue;
          if (isGenericDialogClick(snap.code)) continue; // benign collapse target
          const tokens = extractTokens(snap.code);
          if (tokens.length > 0 && tokens.some(t => tokenSurvives(t, outConcat))) continue;
          silentDrops.push({ code: snap.code, tokens });
        }
        if (silentDrops.length > 0) {
          console.warn(`[recorder] PIPELINE INTEGRITY: ${silentDrops.length} step(s) disappeared without any token surviving`);
          for (const s of silentDrops) {
            console.warn(`[recorder]   silent drop: ${s.code.substring(0, 120)} | tokens=[${s.tokens.join(', ').substring(0, 80)}]`);
          }
        } else {
          console.log(`[recorder] Pipeline integrity OK: parsed=${parseSnapshot.length} → final=${result.length}, every step accounted for`);
        }
      } catch (intErr) {
        console.error(`[recorder] Pipeline integrity check failed: ${intErr.message}`);
      }

      return result;
    }

    return actions;
  }


}

module.exports = new CodegenParserService();

