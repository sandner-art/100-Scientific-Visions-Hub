const { Octokit } = require('@octokit/rest');
const fs = require('fs').promises;

class ScientificVisionsTracker {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN
    });
    this.owner = process.env.GITHUB_OWNER;
    this.repoFullName = process.env.GITHUB_REPOSITORY;
    this.papers = [];
    this.stats = {
      total: 0,
      byStatus: {},
      byPriority: {},
      recentActivity: [],
      weeklyCommits: 0
    };
  }

  async parseFileContent(owner, repoName, filePath) {
    console.log(`DEBUG: Attempting to read: ${owner}/${repoName}/${filePath}`);
    try {
      const { data: file } = await this.octokit.rest.repos.getContent({
        owner, repo: repoName, path: filePath, request: { retries: 0 }
      });
      if (file.content) {
        console.log(`DEBUG: Content found for ${filePath} in ${owner}/${repoName}`);
        return Buffer.from(file.content, 'base64').toString();
      }
      console.log(`DEBUG: File ${filePath} in ${owner}/${repoName} has no content field.`);
    } catch (error) { 
        console.log(`DEBUG: File not found or error reading ${owner}/${repoName}/${filePath}: ${error.message}`);
    }
    return null;
  }

  parseProgress(content) {
    console.log(`DEBUG: Parsing progress.md content snippet:\n---\n${content.substring(0, 400)}\n---`);
    const progress = {
      title: null, status: null, priority: null, phase: [], preprintLink: null, publishedLink: null
    };

    const extractValue = (labelRegex, fieldName) => {
        const match = content.match(labelRegex);
        if (match) {
            const value = (match[1] || match[2] || "").trim();
            // console.log(`DEBUG: Matched ${fieldName}: '${value}'`);
            return value;
        }
        // console.log(`DEBUG: No match for ${fieldName}.`);
        return null;
    };

    progress.title = extractValue(/^\*\*Paper Title\*\*:\s*(?:\[(.*?)\]|(.*?))(?:\r?\n|$)/im, "Paper Title");
    progress.status = extractValue(/^\*\*Status\*\*:\s*(?:\[(.*?)\]|(.*?))(?:\r?\n|$)/im, "Status");
    progress.priority = extractValue(/^\*\*Priority\*\*:\s*(?:\[(.*?)\]|(.*?))(?:\r?\n|$)/im, "Priority");
    
    const preprintRegex = /^\*\*Preprint\*\*:\s*(?:\[[^\]]+\]\(([^)]+)\)|([^\s]+))\s*$/im;
    const preprintMatchResult = content.match(preprintRegex);
    if (preprintMatchResult) {
        const url = (preprintMatchResult[1] || preprintMatchResult[2] || '').trim();
        if (url && !url.toLowerCase().startsWith('[link')) {
            progress.preprintLink = url;
            // console.log(`DEBUG: Matched Preprint Link: '${progress.preprintLink}'`);
        }
    } else { /* console.log("DEBUG: No preprint link match"); */ }


    const publishedRegex = /^\*\*Published\*\*:\s*(?:\[[^\]]+\]\(([^)]+)\)|([^\s]+))\s*$/im;
    const publishedMatchResult = content.match(publishedRegex);
    if (publishedMatchResult) {
        const url = (publishedMatchResult[1] || publishedMatchResult[2] || '').trim();
        if (url && !url.toLowerCase().startsWith('[doi')) {
            progress.publishedLink = url;
            // console.log(`DEBUG: Matched Published Link: '${progress.publishedLink}'`);
        }
    } else { /* console.log("DEBUG: No published link match"); */ }

    const phaseMatches = content.match(/- \[x\]\s*([^\r\n]+)/gim);
    if (phaseMatches) {
        progress.phase = phaseMatches.map(match => match.replace(/- \[x\]\s*/i, '').trim());
        // console.log(`DEBUG: Matched Phases: ${JSON.stringify(progress.phase)}`);
    } else { /* console.log("DEBUG: No phases matched"); */ }
    
    return progress;
  }
  
  parse100SV(content) {
    // console.log(`DEBUG: Parsing 100SV.md content snippet:\n---\n${content.substring(0, 300)}\n---`);
    const svData = { projectId: null, researchArea: null, researchFocus: null };
    const extractValue = (labelRegex) => {
        const match = content.match(labelRegex);
        if (match && match[1]) return match[1].trim();
        return null;
    };
    svData.projectId = extractValue(/^\*\*Project ID\*\*:\s*\[?([^\]\r\n]+?)\]?/im);
    svData.researchArea = extractValue(/^\*\*Research Area\*\*:\s*\[?([^\]\r\n]+?)\]?/im);

    const focusMatch = content.match(/^## Research Focus\s*\n+([\s\S]*?)(?=\n##|\n---|\n\*{3,}|$)/im);
    if (focusMatch && focusMatch[1]) svData.researchFocus = focusMatch[1].trim(); 
    // console.log(`DEBUG: Parsed 100SV Data: ${JSON.stringify(svData)}`);
    return svData;
  }

  async getHistoricalStats(repo) {
    console.log(`DEBUG [${repo.name}]: Getting historical stats...`);
    try {
      const createdAt = new Date(repo.created_at);
      const now = new Date();
      const ageInDays = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
      let totalCommits3Months = 0;
      // Decide if you want to fetch for private repos - requires PAT with repo scope
      // const fetchForPrivate = true; // Set to true to attempt fetch for private repos
      // if (!repo.private || fetchForPrivate) {
      if (!repo.private) { // Current default: only for public repos
        try {
          const threeMonthsAgo = new Date(); threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
          for await (const { data: commitPage } of this.octokit.paginate.iterator(
            this.octokit.rest.repos.listCommits, 
            { owner: repo.owner.login, repo: repo.name, since: threeMonthsAgo.toISOString(), per_page: 100 }
          )) { totalCommits3Months += commitPage.length; }
          console.log(`DEBUG [${repo.name}]: 3-month commits: ${totalCommits3Months}`);
        } catch (e) { 
            console.error(`ERROR fetching 3-month commits for ${repo.name}: ${e.message} (Status: ${e.status})`);
        }
      } else {
        console.log(`DEBUG [${repo.name}]: Skipping 3-month commit history for private repo.`);
      }
      return { age: ageInDays, totalCommits3Months, createdAt: repo.created_at };
    } catch (e) { console.error(`Error in getHistoricalStats for ${repo.name}: ${e.message}`); return null; }
  }

  async getWeeklyCommits(repoOwner, repoName, isPrivate) {
    console.log(`DEBUG [${repoName}]: Getting weekly commits... Private: ${isPrivate}`);
    let count = 0, lastMessage = null;
    if (!repoOwner || !repoName) return { count, lastMessage };
    // const fetchForPrivate = true; // Set to true to attempt fetch for private repos
    // if (!isPrivate || fetchForPrivate) {
    if (!isPrivate) { // Current default: only for public
        try {
            const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
            for await (const { data: page } of this.octokit.paginate.iterator(
                this.octokit.rest.repos.listCommits,
                { owner: repoOwner, repo: repoName, since: weekAgo.toISOString(), per_page: 100 }
            )) {
                if (page.length > 0 && !lastMessage && page[0].commit) lastMessage = page[0].commit.message.split('\n')[0];
                count += page.length;
            }
            console.log(`DEBUG [${repoName}]: Weekly commits: ${count}`);
        } catch (e) { 
            console.error(`ERROR fetching weekly commits for ${repoName}: ${e.message} (Status: ${e.status})`);
        }
    } else {
        console.log(`DEBUG [${repoName}]: Skipping weekly commit history for private repo.`);
    }
    return { count, lastMessage };
  }

  async analyzeSinglePaper(repo) {
    console.log(`DEBUG: Analyzing single paper: ${repo.full_name}`);
    const paper = {
      repoName: repo.name, paperName: repo.name, fullName: repo.full_name, // Use full_name from API
      description: repo.description || 'No repository description.',
      url: repo.html_url, repoUrl: repo.html_url, private: repo.private,
      topics: repo.topics || [], lastUpdated: repo.updated_at, title: null,
      status: 'Unknown', priority: 'Medium', progress: { phase: [] },
      commitsLastWeek: 0, historical: null,
      preprintLink: null, publishedLink: null, isSubpaper: false,
      projectId: null, researchArea: null,
    };

    const svContent = await this.parseFileContent(repo.owner.login, repo.name, '100SV.md');
    if (svContent) {
        const sv = this.parse100SV(svContent);
        if (sv.researchFocus) paper.description = sv.researchFocus;
        paper.projectId = sv.projectId; paper.researchArea = sv.researchArea;
    }

    let t = null, s = null, pVal = null;
    const progressMdPath = 'papers/progress.md';
    const progressMd = await this.parseFileContent(repo.owner.login, repo.name, progressMdPath);
    console.log(`DEBUG [${paper.fullName}]: progress.md content for '${progressMdPath}' ${progressMd ? 'FOUND' : 'NOT FOUND'}`);
    if (progressMd) {
      const prog = this.parseProgress(progressMd);
      paper.progress = prog; 
      if (prog.title) t = prog.title; 
      if (prog.status) s = prog.status;
      if (prog.priority) pVal = prog.priority;
      paper.preprintLink = prog.preprintLink; paper.publishedLink = prog.publishedLink;
      console.log(`DEBUG [${paper.fullName}]: Parsed from progress.md - Title: ${t}, Status: ${s}, Priority: ${pVal}`);
    }

    if (t) { paper.title = t; paper.paperName = t; } // paperName becomes the actual title
    paper.status = s || (await this.inferStatusFromActivity(repo, 'papers/'));
    paper.priority = pVal || 'Medium';
    console.log(`DEBUG [${paper.fullName}]: Final - Title: ${paper.title}, Status: ${paper.status}, Priority: ${paper.priority}`);

    paper.historical = await this.getHistoricalStats(repo);
    // Pass repo.private to getWeeklyCommits
    const weekly = await this.getWeeklyCommits(repo.owner.login, repo.name, repo.private);
    paper.commitsLastWeek = weekly.count;
    if (weekly.count > 0) {
        this.stats.recentActivity.push({ repo: paper.fullName, commits: weekly.count, lastCommit: weekly.lastMessage });
    }
    return paper;
  }

  async analyzeSubpaper(repo, subpaperDir) {
    console.log(`DEBUG: Analyzing sub-paper: ${repo.full_name}/${subpaperDir}`);
    const paper = {
      repoName: repo.name, paperName: subpaperDir, fullName: `${repo.full_name}/${subpaperDir}`,
      description: repo.description || 'No repository description.',
      url: `${repo.html_url}/tree/main/papers/${subpaperDir}`, repoUrl: repo.html_url,
      private: repo.private, topics: repo.topics || [], lastUpdated: repo.updated_at,
      title: null, status: 'Unknown', priority: 'Medium', progress: { phase: [] },
      preprintLink: null, publishedLink: null, isSubpaper: true,
      projectId: null, researchArea: null
    };

    const svSub = await this.parseFileContent(repo.owner.login, repo.name, `papers/${subpaperDir}/100SV.md`);
    if (svSub) {
        const sv = this.parse100SV(svSub);
        if (sv.researchFocus) paper.description = sv.researchFocus;
        paper.projectId = sv.projectId; paper.researchArea = sv.researchArea;
    } else { 
        const svRoot = await this.parseFileContent(repo.owner.login, repo.name, '100SV.md');
        if (svRoot) {
            const svR = this.parse100SV(svRoot);
            if (!paper.projectId) paper.projectId = svR.projectId;
            if (!paper.researchArea) paper.researchArea = svR.researchArea;
            if (!svSub && svR.researchFocus && paper.description === repo.description) paper.description = svR.researchFocus;
        }
    }

    let t = null, s = null, pVal = null;
    const progressMdPath = `papers/${subpaperDir}/progress.md`;
    const progressMd = await this.parseFileContent(repo.owner.login, repo.name, progressMdPath);
    console.log(`DEBUG [${paper.fullName}]: progress.md content for '${progressMdPath}' ${progressMd ? 'FOUND' : 'NOT FOUND'}`);
    if (progressMd) {
      const prog = this.parseProgress(progressMd);
      paper.progress = prog;
      if (prog.title) t = prog.title; 
      if (prog.status) s = prog.status;
      if (prog.priority) pVal = prog.priority;
      paper.preprintLink = prog.preprintLink; paper.publishedLink = prog.publishedLink;
      console.log(`DEBUG [${paper.fullName}]: Parsed from progress.md - Title: ${t}, Status: ${s}, Priority: ${pVal}`);
    }

    if (t) { paper.title = t; paper.paperName = t; }
    paper.status = s || (await this.inferStatusFromActivity(repo, `papers/${subpaperDir}/`));
    paper.priority = pVal || 'Medium';
    console.log(`DEBUG [${paper.fullName}]: Final - Title: ${paper.title}, Status: ${paper.status}, Priority: ${paper.priority}`);
    return paper;
  }

  async inferStatusFromActivity(repo, specificPath = null) {
    let dateToUse = repo.updated_at; 
    if (specificPath && !repo.private) { // Only check path for public repos for now
        try {
            const { data: c } = await this.octokit.rest.repos.listCommits({ owner: repo.owner.login, repo: repo.name, path: specificPath, per_page: 1 });
            if (c.length > 0 && c[0].commit.committer?.date) dateToUse = c[0].commit.committer.date;
        } catch (e) { /* Use repo updated_at */ }
    }
    const days = Math.floor((new Date() - new Date(dateToUse)) / (1000*60*60*24));
    if (days < 7) return 'Active'; if (days < 30) return 'Recent';
    if (days < 90) return 'Inactive'; return 'Stale';
  }
  
  async discoverPapers() {
    console.log('🔍 Discovering paper repositories...');
    const targets = [{ type: 'user', name: this.owner }];
    this.papers = []; this.stats.recentActivity = []; 
    let itemsCount = 0;
    try {
      for (const target of targets) {
        console.log(`DEBUG: Scanning target: ${target.type}/${target.name}`);
        const params = target.type === 'org' ? { org: target.name, type: 'all', per_page: 100 } : { username: target.name, type: 'all', per_page: 100 };
        for await (const { data: page } of this.octokit.paginate.iterator(
          target.type === 'org' ? this.octokit.rest.repos.listForOrg : this.octokit.rest.repos.listForUser, params
        )) {
          for (const repo of page) {
            console.log(`DEBUG: Checking repo: ${repo.full_name}, Private: ${repo.private}`);
            if (this.repoFullName && repo.full_name.toLowerCase() === this.repoFullName.toLowerCase()) {
                console.log(`DEBUG: Skipping self (hub repository): ${repo.full_name}`);
                continue; 
            }
            if (await this.is100SVRepository(repo)) {
              console.log(`DEBUG: Repo ${repo.full_name} IS identified as 100SV. Analyzing...`);
              const list = await this.analyzePaper(repo);
              if (list?.length > 0) { this.papers.push(...list); itemsCount += list.length; }
            } else {
              // console.log(`DEBUG: Repo ${repo.full_name} is NOT 100SV.`);
            }
          }
        }
      }
      console.log(`📊 Found ${itemsCount} paper items.`);
      this.papers.sort((a,b) => (a.fullName||'').localeCompare(b.fullName||''));
    } catch (e) { console.error(`❌ Error discovering papers: ${e.message}`, e.stack); }
  }

  async is100SVRepository(repo) {
    // console.log(`DEBUG [${repo.full_name}]: Checking if 100SV repo...`);
    try { 
      await this.octokit.rest.repos.getContent({ owner: repo.owner.login, repo: repo.name, path: '100SV.md', request: {retries:0}}); 
      // console.log(`DEBUG [${repo.full_name}]: Found 100SV.md.`);
      return true; 
    } catch (e) { /* console.log(`DEBUG [${repo.full_name}]: No 100SV.md.`); */ }
    if (repo.topics?.includes('100-scientific-visions')) {
        // console.log(`DEBUG [${repo.full_name}]: Found '100-scientific-visions' topic.`);
        return true;
    }
    return false;
  }
  
  async analyzePaper(repo) {
    // console.log(`DEBUG [${repo.full_name}]: Starting analyzePaper.`);
    const list = []; const subDirs = await this.findSubpapers(repo); 
    if (subDirs.length > 0) {
      console.log(`DEBUG [${repo.full_name}]: Found ${subDirs.length} sub-paper directories: ${subDirs.join(', ')}`);
      for (const sd of subDirs) { const d = await this.analyzeSubpaper(repo, sd); if (d) list.push(d); }
    } else { 
      console.log(`DEBUG [${repo.full_name}]: No sub-paper directories, analyzing as single paper.`);
      const d = await this.analyzeSinglePaper(repo); if (d) list.push(d); 
    }
    return list;
  }

  async findSubpapers(repo) {
    const names = [];
    try {
      // Check if 'papers' directory itself exists first
      await this.octokit.rest.repos.getContent({ owner: repo.owner.login, repo: repo.name, path: 'papers', request: { retries: 0 }});
      const { data: c } = await this.octokit.rest.repos.getContent({ owner: repo.owner.login, repo: repo.name, path: 'papers' });
      if (Array.isArray(c)) c.forEach(item => { if (item.type === 'dir') names.push(item.name); });
    } catch (e) { /* 'papers' dir missing or error */ }
    // console.log(`DEBUG [${repo.full_name}]: Found subpaper dirs: ${names.join(', ')}`);
    return names;
  }

  generateStats() {
    console.log("DEBUG: Generating stats...");
    this.stats.total = this.papers.length;
    this.stats.byStatus = {}; this.stats.byPriority = {};
    const weeklyCommitsMap = new Map();

    this.papers.forEach(p => { 
        const stat = p.status || 'Unknown'; this.stats.byStatus[stat] = (this.stats.byStatus[stat] || 0) + 1; 
        const prio = p.priority || 'Medium'; this.stats.byPriority[prio] = (this.stats.byPriority[prio] || 0) + 1; 
        if (!p.isSubpaper && typeof p.commitsLastWeek === 'number' && p.commitsLastWeek > 0) {
            weeklyCommitsMap.set(p.repoName, p.commitsLastWeek);
        }
    });
    this.stats.weeklyCommits = Array.from(weeklyCommitsMap.values()).reduce((s, c) => s + c, 0);
    this.stats.recentActivity.sort((a, b) => b.commits - a.commits); // recentActivity is already populated
    this.stats.recentActivity = this.stats.recentActivity.slice(0, 10);
    console.log(`DEBUG: Final Stats: Total=${this.stats.total}, WeeklyCommits=${this.stats.weeklyCommits}, Statuses=${JSON.stringify(this.stats.byStatus)}`);
  }

  async updateReadme() {
    console.log("DEBUG: Updating README.md...");
    const ts = new Date().toISOString().slice(0,16).replace('T',' ') + ' UTC';
    const hubUrl = (this.owner && this.repoFullName?.includes('/')) ? `https://${this.owner}.github.io/${this.repoFullName.split('/')[1]}/` : `<!-- Hub Dashboard URL Error -->`;
    let md = `# 100 Scientific Visions by Daniel Sandner

## Project Overview
A comprehensive research initiative encompassing 100+ scientific papers across multiple research programs and topics.

## Current Status Dashboard
*Last updated: ${ts}*

### Quick Stats
- 📊 **Total Papers Tracked**: ${this.stats.total}
- 🟢 **Active Projects**: ${this.stats.byStatus['Active']||0}
- 🟡 **In Planning**: ${this.stats.byStatus['Planning']||0}
- 🔴 **Stale (Needs Attention)**: ${this.stats.byStatus['Stale']||0}
- 📈 **This Week's Commits (Public Repos)**: ${this.stats.weeklyCommits}

### Recent Activity (Top 10 Public Repos by Weekly Commits)
`;
    if(this.stats.recentActivity.length > 0) {
        this.stats.recentActivity.forEach(a => {
            const commitMsg = (a.lastCommit||"N/A").substring(0,70);
            md += `- **${a.repo}**: ${a.commits} commits - "${commitMsg}${(a.lastCommit||"").length > 70 ? '...' : ''}"\n`;
        });
    } else {
        md += `*No recent commit activity detected in tracked public repositories.*\n`;
    }
    md += `
## Research Areas
*Categorization based on repository topics or 'Research Area' in 100SV.md files.*

### By Status
`;
    const sts = Object.keys(this.stats.byStatus).sort(); 
    if(sts.length>0) {
        sts.forEach(s => {md += `- **${s}**: ${this.stats.byStatus[s]} papers\n`;});
    } else {
        md += `*No status data available.*\n`;
    }
    md += `
### Priority Distribution
`;
    const pri = Object.keys(this.stats.byPriority).sort((a,b)=>({'High':0,'Medium':1,'Low':2}[a]??99)-({'High':0,'Medium':1,'Low':2}[b]??99)); 
    if(pri.length>0) {
        pri.forEach(pVal=>{md+=`- ${this.getPriorityEmoji(pVal)} **${pVal} Priority**: ${this.stats.byPriority[pVal]} papers\n`;});
    } else {
        md += `*No priority data available.*\n`;
    }
    md += `
## Quick Actions & Links
- [📊 Interactive Dashboard](${hubUrl})
- [📋 View Detailed Progress Report](./reports/detailed-progress.md)
- [🔄 Update Status Manually](../../actions) (Run "Update Project Status" workflow)

## About This System
This dashboard is automatically updated by GitHub Actions. For more information on setup, repository identification, and customization, see [SETUP.md](./setup.md).

---

*This dashboard is part of the 100 Scientific Visions initiative by Daniel Sandner.*`;
    await fs.writeFile('README.md', md);
  }

  async generateDetailedReport() {
    console.log("DEBUG: Generating detailed report...");
    const now = new Date(); const genDate = now.toISOString().slice(0,10); const genTime = now.toTimeString().slice(0,8);
    let report = `# Detailed Progress Report\n*Generated: ${genDate} ${genTime} UTC*\n\n## All Tracked Paper Items (${this.papers.length} total)\n\n`;
    report += `| Title / Location                 | Status                      | Priority                      | Progress                               | Links                                     | Last Repo Update |\n`;
    report += `|:---------------------------------|:----------------------------|:------------------------------|:---------------------------------------|:------------------------------------------|:-----------------|\n`;
    if (this.papers.length === 0) { report += `| *No paper items found or tracked.* | - | - | - | - | - |\n`; }
    else {
      this.papers.forEach(p => {
        const displayName = p.title || p.paperName || 'Untitled';
        let locationHint = '';
        if (p.isSubpaper) { 
            locationHint = `<br><small>(${p.fullName})</small>`;
        } else if (displayName !== p.repoName && p.repoName !== p.paperName) { 
            locationHint = `<br><small>(${p.repoName})</small>`;
        }
        const viewLink = `<a href="${p.url}" target="_blank" title="View Paper Location">View</a>`;
        const links = [viewLink];
        if (p.preprintLink) links.unshift(`<a href="${p.preprintLink}" target="_blank" title="Preprint">Preprint</a>`);
        if (p.publishedLink) links.unshift(`<a href="${p.publishedLink}" target="_blank" title="Published">Published</a>`);
        
        report += `| **${displayName}**${locationHint} | ${this.getStatusEmoji(p.status)} ${p.status||'N/A'} | ${this.getPriorityEmoji(p.priority)} ${p.priority||'N/A'} | \`${this.generateProgressBar(p.progress?.phase)}\` | ${links.join(' • ')} | ${new Date(p.lastUpdated).toLocaleDateString()} |\n`;
      });
    }
    report += `\n## Detailed Information by Repository\n`;
    const papersByRepo = this.papers.reduce((acc,item) => { (acc[item.repoName] = acc[item.repoName] || []).push(item); return acc; }, {});
    if (Object.keys(papersByRepo).length === 0) { report += `*No repositories to detail.*\n`; }
    else {
      Object.keys(papersByRepo).sort().forEach(repoName => {
        const itemsInRepo = papersByRepo[repoName]; 
        const repoDataForHeader = itemsInRepo[0]; 

        report += `\n### 📁 Repository: [${repoName}](${repoDataForHeader.repoUrl})\n`;
        
        const mainNonSubpaperItem = itemsInRepo.find(it => !it.isSubpaper);
        const descriptionToDisplay = mainNonSubpaperItem?.description || repoDataForHeader.description || 'N/A';
        report += `- **Repo Description**: ${descriptionToDisplay}\n`;
        report += `- **Topics**: ${(repoDataForHeader.topics||[]).join(', ') || 'None'}\n`;
        report += `- **Visibility**: ${repoDataForHeader.private ? 'Private' : 'Public'}\n`;
        
        // Prefer historical data from the main non-subpaper item if it exists
        const historicalDataSource = mainNonSubpaperItem || itemsInRepo.find(it => it.historical);
        if (historicalDataSource?.historical) { 
            const hist = historicalDataSource.historical;
            report += `- **Created**: ${new Date(hist.createdAt).toLocaleDateString()} (${hist.age} days ago)\n`; 
            if (!repoDataForHeader.private && typeof hist.totalCommits3Months === 'number') { 
                report += `- **Commits (3 months)**: ${hist.totalCommits3Months}\n`; 
            }
        }
        // Prefer weekly commits from the main non-subpaper item
        const weeklyCommitDataSource = mainNonSubpaperItem || itemsInRepo.find(it => typeof it.commitsLastWeek === 'number');
        if (weeklyCommitDataSource && typeof weeklyCommitDataSource.commitsLastWeek === 'number' /*&& !repoDataForHeader.private - this condition is now in getWeeklyCommits itself */ ) {
            report += `- **Weekly Commits (this repo)**: ${weeklyCommitDataSource.commitsLastWeek}\n`;
        }

        if (itemsInRepo.length === 1 && !itemsInRepo[0].isSubpaper) {
          const p = itemsInRepo[0]; 
          report += `- **Paper Title**: ${p.title||p.paperName||'N/A'}\n`;
          report += `- **Status**: ${this.getStatusEmoji(p.status)} ${p.status||'N/A'}\n`;
          report += `- **Priority**: ${this.getPriorityEmoji(p.priority)} ${p.priority||'N/A'}\n`;
          report += `- **Progress**: \`${this.generateProgressBar(p.progress?.phase)}\`\n`;
          if (p.projectId) report += `- **Project ID**: ${p.projectId}\n`; 
          if (p.researchArea) report += `- **Research Area**: ${p.researchArea}\n`; 
          if (p.preprintLink) report += `- **Preprint**: [Link](${p.preprintLink})\n`; 
          if (p.publishedLink) report += `- **Published**: [Link](${p.publishedLink})\n`;
        } else { 
          report += `\n  *Contains ${itemsInRepo.length} paper items:*\n`;
          itemsInRepo.forEach(p => { 
            report += `  - #### ${this.getStatusEmoji(p.status)} ${p.title||p.paperName||'Untitled Sub-paper'}\n`; 
            if (p.title && p.paperName !== p.title && p.isSubpaper) { report += `    - **Directory Name**: \`${p.paperName}\`\n`; }
            if (p.description && p.description !== descriptionToDisplay) {
                 report += `    - **Description (Specific)**: ${p.description}\n`;
            }
            report += `    - **Status**: ${p.status||'N/A'} | **Priority**: ${p.priority||'N/A'}\n`; 
            report += `    - **Progress**: \`${this.generateProgressBar(p.progress?.phase)}\`\n`;
            if (p.projectId) report += `    - **Project ID**: ${p.projectId}\n`; 
            if (p.researchArea) report += `    - **Research Area**: ${p.researchArea}\n`; 
            if (p.preprintLink) report += `    - **Preprint**: [Link](${p.preprintLink})\n`; 
            if (p.publishedLink) report += `    - **Published**: [Link](${p.publishedLink})\n`; 
            report += `    - **Link**: [View Paper Directory](${p.url})\n\n`;
          });
        }
        report += `\n---\n`;
      });
    }
    await fs.writeFile('reports/detailed-progress.md', report);
  }

  generateProgressBar(phases=[]) {
    const totalPhases = 12; const completed = Array.isArray(phases) ? phases.length : 0;
    if (totalPhases === 0) return `░░░░░░░░░░ 0% (No phases defined)`;
    const percentage = Math.round((completed / totalPhases) * 100); 
    const filledBlocks = Math.min(10, Math.round((completed / totalPhases) * 10));
    const emptyBlocks = 10 - filledBlocks;
    return `${'█'.repeat(filledBlocks)}${'░'.repeat(emptyBlocks)} ${percentage}%`;
  }
  getStatusEmoji(status) {
    const emojis = {'Active':'🟢','Planning':'🟡','Review':'🔵','Complete':'✅','Stale':'🔴','Inactive':'⚪','Recent':'🟠','Analysis':'🟣','Writing':'✍️','On-Hold':'⏸️','Unknown':'❓'};
    return emojis[status] || '❓';
  }
  getPriorityEmoji(priority) {
    const emojis = {'High':'🔴','Medium':'🟡','Low':'🟢'};
    return emojis[priority] || '⚪';
  }

  async saveData() {
    await fs.mkdir('data', {recursive:true});
    const sortedPapers = [...this.papers].sort((a,b)=>(a.fullName||'').localeCompare(b.fullName||''));
    await fs.writeFile('data/papers.json', JSON.stringify(sortedPapers,null,2));
    await fs.writeFile('data/stats.json', JSON.stringify(this.stats,null,2));
  }

  async run() {
    console.log('🚀 Starting Scientific Visions Tracker...');
    if(!this.owner){console.error("❌ GITHUB_OWNER environment variable missing. Cannot determine scan targets."); process.exit(1);}
    
    await this.discoverPapers();
    this.generateStats(); 
    await this.updateReadme(); 
    await this.generateDetailedReport(); 
    await this.saveData(); 
    
    console.log('🎉 Tracker run complete!');
    console.log(`📊 Total papers processed: ${this.stats.total}.`);
    console.log(`📈 Total weekly commits for tracked public repos: ${this.stats.weeklyCommits}.`);
  }
}
(async()=>{
  const tracker = new ScientificVisionsTracker();
  try {
    await tracker.run();
  } catch(e) {
    console.error("❌ Global Error in tracker execution:", e);
    process.exit(1);
  }
})();