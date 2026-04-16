import { Router } from 'express';
import { NodeRegistry } from '../services/node-registry';
import { NodeAuthMiddleware } from '../middleware/node-auth';

const router = Router();
const nodeRegistry = new NodeRegistry();

router.post('/register', async (req, res) => {
    try {
        const { node_name, platform, gateway_url } = req.body;
        const result = await nodeRegistry.register(node_name, { platform, gateway_url });
        res.json({ success: true, node: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/status/:nodeName', async (req, res) => {
    try {
        const status = await nodeRegistry.getStatus(req.params.nodeName);
        res.json(status);
    } catch (error) {
        res.status(404).json({ error: 'Node not found' });
    }
});

router.post('/commands/:nodeName', async (req, res) => {
    try {
        const command = await nodeRegistry.queueCommand(req.params.nodeName, req.body);
        res.json({ accepted: true, command_id: command.id });
    } catch (error) {
        res.status(500).json({ accepted: false, reason: error.message });
    }
});

router.get('/results/:commandId', async (req, res) => {
    try {
        const result = await nodeRegistry.getResult(req.params.commandId);
        if (result) {
            res.json(result);
        } else {
            res.status(404).json({ error: 'Result not ready' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/heartbeat', async (req, res) => {
    try {
        const { node_name, status, metrics } = req.body;
        await nodeRegistry.updateHeartbeat(node_name, { status, metrics });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
