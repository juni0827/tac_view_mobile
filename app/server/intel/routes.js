export function registerIntelRoutes(app, intelService) {
  app.get('/api/intel/acled', async (req, res) => {
    const options = intelService.buildIntelRequestOptions(req.query);
    const result = await intelService.resolveIntelSource(() => intelService.fetchAcledIntel(options));
    res.json({ items: result.items, source: 'acled', status: result.status });
  });

  app.get('/api/intel/gdelt/doc', async (req, res) => {
    const options = intelService.buildIntelRequestOptions(req.query);
    const result = await intelService.resolveIntelSource(() => intelService.fetchGdeltDocIntel(options));
    res.json({ items: result.items, source: 'gdelt-doc', status: result.status });
  });

  app.get('/api/intel/gdelt/geo', async (req, res) => {
    try {
      const payload = await intelService.fetchGdeltGeoIntel(req.query);
      res.json({ source: 'gdelt-geo', payload });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/intel/reliefweb', async (req, res) => {
    const options = intelService.buildIntelRequestOptions(req.query);
    const result = await intelService.resolveIntelSource(() => intelService.fetchReliefWebIntel(options));
    res.json({ items: result.items, source: 'reliefweb', status: result.status });
  });

  app.get('/api/intel/newsapi', async (req, res) => {
    const options = intelService.buildIntelRequestOptions(req.query);
    const result = await intelService.resolveIntelSource(() => intelService.fetchNewsApiIntel(options));
    res.json({ items: result.items, source: 'newsapi', status: result.status });
  });

  app.get('/api/intel/briefing', async (req, res) => {
    const options = intelService.buildIntelRequestOptions(req.query);
    res.json(await intelService.buildBriefing(options));
  });
}
