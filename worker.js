// worker.js
const SUB_TYPES = {
  clash: { format: 'yaml', type: 'text/yaml; charset=utf-8' },
  singbox: { format: 'json', type: 'application/json; charset=utf-8' }
};

const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>订阅转换服务</title>
  <style>
    body { font-family: sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem }
    .container { background: #f5f6fa; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1) }
    input, textarea { width: 100%; padding: 0.8rem; margin: 0.5rem 0; border: 1px solid #ddd; border-radius: 4px }
    button { background: #2185d0; color: white; border: none; padding: 0.8rem 1.5rem; border-radius: 4px; cursor: pointer }
    #result { margin-top: 1rem; padding: 1rem; background: #e8f4fc; border-radius: 4px }
  </style>
</head>
<body>
  <div class="container">
    <h1>订阅转换器</h1>
    <form id="converter">
      <input type="url" name="subUrl" placeholder="订阅链接" required>
      <textarea name="base64Sub" placeholder="或直接粘贴Base64内容" rows="4"></textarea>
      <input type="url" name="config" placeholder="转换配置URL (可选)" 
             value="https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online_Full.ini">
      <div class="actions">
        <button type="submit" name="type" value="clash">生成Clash配置</button>
        <button type="submit" name="type" value="singbox">生成Singbox配置</button>
      </div>
    </form>
    <div id="result"></div>
  </div>
  <script>
    document.getElementById('converter').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const response = await fetch('/convert', {
        method: 'POST',
        body: formData
      });
      const data = await response.json();
      if (data.url) {
        document.getElementById('result').innerHTML = 
          `<a href="${data.url}" target="_blank" style="color:#2185d0;text-decoration:none">✅ 生成成功，点击下载配置</a>`;
      } else {
        document.getElementById('result').innerHTML = 
          `<div style="color:red">错误: ${data.error || '未知错误'}</div>`;
      }
    });
  </script>
</body>
</html>`;

async function parseBase64Sub(base64Str) {
  try {
    const binaryString = atob(base64Str);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const decoded = new TextDecoder('utf-8').decode(bytes);
    return decoded.split('\n').filter(l => l.startsWith('ss://')).map(node => {
      const [info, remark] = node.split('#');
      const decodedInfo = atob(info.slice(5));
      const [methodPassword, serverPort] = decodedInfo.split('@');
      const [method, password] = methodPassword.split(':');
      const [server, port] = serverPort.split(':');
      return { 
        type: 'ss', 
        server: server.trim(),
        port: parseInt(port),
        method: method.trim(),
        password: password.trim(),
        name: remark ? decodeURIComponent(remark).trim() : '未命名节点'
      };
    });
  } catch (e) {
    throw new Error('Base64解析失败: ' + e.message);
  }
}

async function applyConfigRules(nodes, configUrl) {
  try {
    const response = await fetch(configUrl);
    const rulesText = await response.text();
    if (rulesText.includes('保留香港节点')) {
      return nodes.filter(n => n.name.includes('香港'));
    }
    if (rulesText.includes('保留美国节点')) {
      return nodes.filter(n => n.name.includes('美国'));
    }
    return nodes;
  } catch (e) {
    throw new Error('规则文件获取失败: ' + e.message);
  }
}

async function generateConfig(type, nodes) {
  switch(type) {
    case 'clash':
      return {
        proxies: nodes.map(n => ({
          name: n.name,
          type: 'ss',
          server: n.server,
          port: n.port,
          cipher: n.method,
          password: n.password
        }))
      };
    case 'singbox':
      return {
        outbounds: nodes.map(n => ({
          type: 'shadowsocks',
          server: n.server,
          server_port: n.port,
          method: n.method,
          password: n.password,
          tag: n.name
        }))
      };
    default:
      throw new Error('不支持的配置类型');
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // 首页
    if (url.pathname === '/') {
      return new Response(html, {
        headers: { 
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'max-age=3600'
        }
      });
    }

    // 处理转换请求
    if (url.pathname === '/convert') {
      try {
        const formData = await request.formData();
        const subUrl = formData.get('subUrl');
        const base64Sub = formData.get('base64Sub');
        const configUrl = formData.get('config');
        const type = formData.get('type');

        // 获取订阅内容
        let subContent;
        if (subUrl) {
          const subResponse = await fetch(subUrl);
          subContent = await subResponse.text();
        } else if (base64Sub) {
          subContent = base64Sub;
        } else {
          throw new Error('请输入订阅链接或Base64内容');
        }

        // 解析节点
        const nodes = await parseBase64Sub(subContent);
        
        // 应用规则
        const filteredNodes = configUrl 
          ? await applyConfigRules(nodes, configUrl)
          : nodes;

        // 生成配置
        const config = await generateConfig(type, filteredNodes);
        const configStr = SUB_TYPES[type].format === 'json'
          ? JSON.stringify(config, null, 2)
          : 'proxies:\n' + config.proxies.map(p => `  - ${JSON.stringify(p)}`).join('\n');

        // 存储配置
        const id = crypto.randomUUID();
        await env.CONFIGS.put(id, configStr, { expirationTtl: 86400 });

        // 验证存储
        const testValue = await env.CONFIGS.get(id);
        if (!testValue) throw new Error('配置存储失败');

        return Response.json({
          url: `${url.origin}/config/${id}.${SUB_TYPES[type].format}`
        }, {
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });

      } catch (e) {
        return Response.json(
          { error: e.message },
          { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
      }
    }

    // 下载配置文件
    if (url.pathname.startsWith('/config/')) {
      try {
        const filename = url.pathname.split('/').pop();
        const [id, format] = filename.split('.');
        
        if (!id || !format) {
          return new Response('无效的URL格式', {
            status: 400,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }

        const config = await env.CONFIGS.get(id);
        if (!config) {
          return new Response('配置不存在或已过期', {
            status: 404,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }

        return new Response(config, {
          headers: {
            'Content-Type': SUB_TYPES[format === 'yaml' ? 'clash' : 'singbox'].type,
            'Content-Disposition': `attachment; filename="config.${format}"`,
            'Cache-Control': 'max-age=3600'
          }
        });

      } catch (e) {
        return new Response('服务器错误', {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};
