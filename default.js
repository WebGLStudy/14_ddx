(function(){
    'use strict';
    
    const HEIGHT_MAP_SIZE = 512;
    const WATER_SIZE = 50.0;

    // 変数
    let gl, canvas;
    let program_water, program_bg, program_scene, program_post, program_debug;
    
    let mesh_full_screen, mesh_debug_plane;
    let mesh_water, wMatrixWater;
    
    let is_dragging = false; // ドラッグ判定
    let is_shoot = false;    // 水面を盛り上げるトリガ
    let shoot_pos = {x: 0.5, y: 0.5}; // クリップ空間でのカーソルの位置

    // 水面を盛り上げろ！
    function shoot(e){
        var cw = canvas.width;
        var ch = canvas.height;
        shoot_pos.x = 2.0 * (e.clientX - canvas.offsetLeft) / cw - 1.0;
        shoot_pos.y = 2.0 * (e.clientY - canvas.offsetTop ) / ch - 1.0;
        is_shoot = true;
    }
    
    window.addEventListener('load', function(){
        ////////////////////////////
        // 初期化
        ////////////////////////////
        
        // canvas の初期化
        canvas = document.getElementById('canvas');
        canvas.width = 512;
        canvas.height = 512;
        
        // ドラッグ開始
        function onMouseDown(e) {
            is_dragging = true; // フラグを立てる
            shoot(e); // クリックした瞬間も水面を上げる
        }
        canvas.addEventListener('mousedown', onMouseDown, false);

        // ドラッグの終了
        function onMouseUp(e) {
            is_dragging = false;
        }
        canvas.addEventListener('mouseup', onMouseUp, false);

        // マウスカーソルを動かしたとき
        function mouseMove(e){
            if(is_dragging) {shoot(e);}// ドラッグしてたら水面を上げる
        }
        canvas.addEventListener('mousemove', mouseMove, false);
        
        // WeebGLの初期化(WebGL 2.0)
        gl = canvas.getContext('webgl2');
        
        // 浮動小数点数レンダーターゲットの確認
        if(gl.getExtension('EXT_color_buffer_float') == null){
            alert('float texture not supported');
            return;
        }
        
        ////////////////////////////
        // プログラムオブジェクトの初期化
        
        // 高さマップの更新
        // r:最新の高さ、g:前のフレームの高さ
        const vsSourceFullScreen = [
            '#version 300 es',
            'in vec3 position;',
            'in vec2 uv;',
            
            'out vec2 vUv;',

            'void main(void) {',
                'gl_Position = vec4(position, 1.0);',
                'vUv = uv;',
            '}'
        ].join('\n');

        const fsSourceWater = [
            '#version 300 es',
            'precision highp float;',
            
            'in vec2 vUv;',
            
            'uniform sampler2D samp;',// 前フレームの結果
            'uniform sampler2D sampBullet;',// 盛り上げテクスチャ
            'uniform vec2 bullet_pos;',

            'out vec2 outHeight;',

            'float interval = 3.0 / 512.0;',// 波紋が広がる速さ
            
            'void main(void) {',
                'vec2 last = texture(samp, vUv).xy;',

                'float s = 0.3;',// ばねの強さ
                'float height = 2.0 * last.x - last.y + s * (',// 位置と速度
                    'texture(samp, vUv + vec2(+interval, 0)).x + ',// ばねによる力の効果
                    'texture(samp, vUv + vec2(-interval, 0)).x + ',
                    'texture(samp, vUv + vec2(0, +interval)).x + ',
                    'texture(samp, vUv + vec2(0, -interval)).x',
                '  - 4.0 * last.x);',
                
                // 弾を打った場所で高さを上げる
                'float bullet_size = 1.0 / 0.05;',// 張り込むテクスチャのテクスチャ空間での広がりの逆数
                'vec2 bullet_center = vec2(0.5, 0.5);',// テクスチャの中心をvUvにするためのずらし
                'float bullet = 5.0 * texture(sampBullet, vUv * bullet_size - bullet_pos * bullet_size + bullet_center).x;',
                'height = height + bullet;',
                
                'outHeight = vec2(0.99 * height, last.x);',// 少しづつ減衰
            '}',

        ].join('\n');

        // 背景用シェーダ
        const vsSourceBg = [
            '#version 300 es',
            'in vec3 position;',
            
            'uniform mat4 mpvMatrixInv;',// ビュー射影行列の逆行列

            'out vec4 vPos;',

            'void main(void) {',
                'gl_Position = vec4(position, 1.0);',
                'vPos = mpvMatrixInv * gl_Position;',// クリップ空間からワールド空間の座標を導出
            '}'
        ].join('\n');

        const fsSourceBg = [
            '#version 300 es',
            'precision highp float;',
            
            'in vec4 vPos;',
            
            'uniform vec3 camera_pos;',
            'uniform samplerCube sampCube;',

            'out vec4 outColor;',

            'void main(void) {',
                'vec3 eye_dir = (vPos.xyz/vPos.w - camera_pos) * vec3(-1,1,1);',
                'outColor  = vec4(texture(sampCube, eye_dir).rgb, 1.0);',
            '}'
        ].join('\n');

        // シーン描画用シェーダ
        const vsSourceScene = [
            '#version 300 es',
            'in vec3 position;',
            'in vec2 uv;',
           
            'uniform vec3 camera_pos;',
            'uniform mat4 mwMatrix;',
            'uniform mat4 mpvMatrix;',
            'uniform sampler2D samp;',
            
            'out vec3 vPosition;',
            'out vec2 vUv;',

            'void main(void) {',
                'float HEIGHT_SCALE = 0.1;',
                'float height = HEIGHT_SCALE * texture(samp, uv).x;',
                'vec4 wpos = mwMatrix * vec4(position.x, position.y + height, position.z, 1.0);',
                'gl_Position = mpvMatrix * wpos;',// 画面に表示される位置
                'vPosition = wpos.xyz;',
                'vUv = uv;',
            '}'
        ].join('\n');

        const fsSourceScene = [
            '#version 300 es',
            'precision highp float;',
            'in vec3 vPosition;',
            'in vec2 vUv;',
            
            'uniform vec3 camera_pos;',
            'uniform samplerCube sampCube;',

            'out vec4 outColor;',

            'void main(void) {',
                'vec3 dPosdx = dFdx(vPosition);',
                'vec3 dPosdy = dFdy(vPosition);',
                'vec2 dUVdx = dFdx(vUv);',
                'vec2 dUVdy = dFdy(vUv);',
                'vec3 T = -dPosdx * dUVdy.y - dPosdy * dUVdx.y;',
                'vec3 B = +dPosdx * dUVdy.x + dPosdy * dUVdx.x;',
                'vec3 normal = normalize(cross(T, B));',
                
                'vec3 view_dir = normalize(camera_pos - vPosition);',

                'float f0 = 0.3;',
                'float f = f0 + (1.0 - f0) * pow(1.0-dot(view_dir, normal), 5.0);', // フレネル項
                'vec3 ref = f * texture(sampCube, reflect(-view_dir, normal) * vec3(-1,1,1)).rgb;',
                
                'outColor = vec4(ref, 1.0);',
            '}'
        ].join('\n');

        // ポストエフェクト
        const fsSourcePost = [
            '#version 300 es',
            'precision highp float;',
            
            'in vec2 vUv;',
            
            'uniform sampler2D samp;',

            'out vec4 outColor;',

            'float A = 0.15;',
            'float B = 0.50;',
            'float C = 0.10;',
            'float D = 0.20;',
            'float E = 0.02;',
            'float F = 0.30;',
            'vec3 Uncharted2Tonemap(vec3 x)',
            '{',
            '   return ((x*(A*x+C*B)+D*E)/(x*(A*x+B)+D*F))-E/F;',
            '}',
            'float Uncharted2Tonemap(float x)',
            '{',
            '   return ((x*(A*x+C*B)+D*E)/(x*(A*x+B)+D*F))-E/F;',
            '}',
            'float Uncharted2WhiteScale(){',
            '   float W = 11.2;',
            '   return 1.0 / Uncharted2Tonemap(W);',
            '}',

            'void main(void) {',
                'vec3 col = texture(samp, vUv).rgb;',
                // トーンマッピング http://filmicworlds.com/blog/filmic-tonemapping-operators/
                'float ExposureBias = 2.0f;',
                'col = Uncharted2Tonemap(ExposureBias * col) * Uncharted2WhiteScale();',
                // ガンマ補正
                'float g = 1.0/2.2;',
                'col  = pow(col, vec3(g,g,g));',
                'outColor  = vec4(col, 1.0);',
            '}',

        ].join('\n');

        // デバッグ用シェーダ
        const vsSourceDebug = [
            '#version 300 es',
            'in vec3 position;',
            'in vec2 uv;',
            
            'uniform mat4 mwMatrix;',
            
            'out vec2 vTexCoord;',

            'void main(void) {',
                'gl_Position = mwMatrix * vec4(position, 1.0);',
                'vTexCoord = uv;',
            '}'
        ].join('\n');

        const fsSourceDebug = [
            '#version 300 es',
            'precision highp float;',
            
            'in vec2 vTexCoord;',
            
            'uniform sampler2D samp;',

            'out vec4 outColor;',

            'void main(void) {',
                'vec4 tex = texture(samp, vTexCoord);',
                'outColor = vec4(tex.rgb, 1.0);',
            '}'
        ].join('\n');
        // シェーダ「プログラム」の初期化
        program_water = create_program(vsSourceFullScreen, fsSourceWater, ['samp', 'sampBullet', 'bullet_pos']);
        program_bg    = create_program(vsSourceBg,         fsSourceBg,    ['sampCube', 'mpvMatrixInv', 'camera_pos']);
        program_scene = create_program(vsSourceScene,      fsSourceScene, ['mwMatrix', 'mpvMatrix', 'camera_pos', 'sampCube', 'samp']);
        program_post  = create_program(vsSourceFullScreen, fsSourcePost,  ['samp']);
        program_debug = create_program(vsSourceDebug,      fsSourceDebug, ['mwMatrix', 'samp']);


        ////////////////////////////
        // フレームバッファオブジェクトの取得
        let floatBuffer = create_framebuffer(canvas.width, canvas.height);
        let heightMap = [// 同じものを二つ作る
            create_rendertarget(HEIGHT_MAP_SIZE, HEIGHT_MAP_SIZE),
            create_rendertarget(HEIGHT_MAP_SIZE, HEIGHT_MAP_SIZE),
            ];
       let heightmap_idx = 0;

        ////////////////////////////
        // テクスチャの読み込み
        let envMap = {tex:null};
        create_cube_texture([
            'img/xp.hdr',
            'img/xn.hdr',
            'img/yp.hdr',
            'img/yn.hdr',
            'img/zp.hdr',
            'img/zn.hdr'],
            envMap);

        // 弾痕テクスチャ。盛り上げる際の形状を決める
        let bulletTex = {tex:null};
        create_texture('img/bullet.png', bulletTex);

        ////////////////////////////
        // モデルの構築
        // 水面
        let WATER_W = 254, WATER_H=254;// 分割数
        let vertex_data_water = [];
        let index_data_water = [];
        for(let z = 0; z <= WATER_H; z++){
            for(let x = 0; x <= WATER_W; x++){
                let fx = WATER_SIZE * (x / WATER_W - 0.5);
                let fz = WATER_SIZE * (z / WATER_H - 0.5);
                vertex_data_water.push(fx);// pos
                vertex_data_water.push(0.0);
                vertex_data_water.push(fz);
                vertex_data_water.push(x / WATER_W);// uv
                vertex_data_water.push(z / WATER_H);
            }
        }
        for(let y = 0; y < WATER_H; y++){
            let id0 = (WATER_W + 1) * y;
            let id1 = id0 + (WATER_W + 1);
            for(let x = 0; x < WATER_W; x++){
                index_data_water.push(id0 + 0);
                index_data_water.push(id1 + 0);
                index_data_water.push(id0 + 1);

                index_data_water.push(id1 + 1);
                index_data_water.push(id0 + 1);
                index_data_water.push(id1 + 0);
                
                id0++;
                id1++;
            }
        }
        mesh_water = createMesh(gl, program_scene.prg, vertex_data_water, index_data_water);

        // 全画面を覆う三角形
        const vertex_data_full_screen = [
         // x    y     z     u    v
          -1.0,-1.0, +1.0,  0.0, 0.0,
          +3.0,-1.0, +1.0,  2.0, 0.0,
          -1.0,+3.0, +1.0,  0.0, 2.0,
        ];
        const index_data_full_screen = [0, 1, 2];
        mesh_full_screen = createMesh(gl, program_post.prg, vertex_data_full_screen, index_data_full_screen);

        // 四角形
        const vertex_data_debug = [
         // x    y     z      u    v 
          -0.5, 0.5, -1.0,   1.0, 0.0,
          -0.5, 1.0, -1.0,   1.0, 1.0,
          -1.0, 0.5, -1.0,   0.0, 0.0,
          -1.0, 1.0, -1.0,   0.0, 1.0,
        ];
        const index_data_debug = [
          0,  1,  2,   3,  2,  1,
        ];
        mesh_debug_plane = createMesh(gl, program_debug.prg, vertex_data_debug, index_data_debug);
        
        ////////////////////////////
        // 各種行列の事前計算
        let mat = new matIV();// 行列のシステムのオブジェクト

        // シーンの射影行列の生成
        let pMatrix   = mat.identity(mat.create());
        mat.perspective(40, canvas.width / canvas.height, 0.01, 100.0, pMatrix);

        // シーンの情報の設定
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);

        ////////////////////////////
        // フレームの更新
        ////////////////////////////
        let lastTime = null;
        let angle = 0.0;// 物体を動かす角度

        window.requestAnimationFrame(update);
        
        function update(timestamp){
            ////////////////////////////
            // 動かす
            ////////////////////////////
            // 更新間隔の取得
            let elapsedTime = lastTime ? timestamp - lastTime : 0;
            lastTime = timestamp;

            // カメラを回すパラメータ
            angle += 0.0001 * elapsedTime;
            if(1.0 < angle) angle -= 1.0;
//angle = 0.9;
            // ワールド行列の生成
            wMatrixWater = mat.identity(mat.create());

            // ビュー行列の生成
            let camera_pos = [20.0 * Math.cos(2.0 * Math.PI*angle), 4.0, 20.0 * Math.sin(2.0 * Math.PI*angle)];
            let look_at = [0.0, 3.0, 0.0];
            let up = [0.0, 1.0, 0.0];
            let vMatrix = mat.create();
            mat.lookAt(camera_pos, look_at, up, vMatrix);

            // ビュー射影行列の生成
            let pvMatrix = mat.create();
            mat.multiply (pMatrix, vMatrix, pvMatrix);
            
            // ビュー射影行列の逆行列を生成
            let pvMatrixInv = mat.create();
            mat.inverse (pvMatrix, pvMatrixInv);
            
            // ダブルバッファを切り替え
            heightmap_idx = 1 - heightmap_idx;
            
            ////////////////////////////
            // 描画
            ////////////////////////////
            
            ////////////////////////////
            // 高さマップの更新
            if(bulletTex.tex){
                gl.bindFramebuffer(gl.FRAMEBUFFER, heightMap[heightmap_idx].f);// 描画対象の切り替え
                gl.viewport(0.0, 0.0, HEIGHT_MAP_SIZE, HEIGHT_MAP_SIZE);
                gl.disable(gl.DEPTH_TEST);// 深度バッファを使わない
                gl.useProgram(program_water.prg);// プログラムオブジェクトとパラメータの設定
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, heightMap[1-heightmap_idx].t);// 書き込んでいないレンダーターゲット
                gl.uniform1i(program_water.loc[0], 0); // 'samp'
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, bulletTex.tex); // 盛り上げる形状
                gl.uniform1i(program_water.loc[1], 1); // 'sampBullet'
                if(is_shoot){
                    is_shoot = false;// 一度打てばフラグを落とす
                    // クリック位置のワールド空間での位置を求める
                    let wx = pvMatrixInv[0] * shoot_pos.x + pvMatrixInv[4] * shoot_pos.y + pvMatrixInv[ 8] + pvMatrixInv[12];
                    let wy = pvMatrixInv[1] * shoot_pos.x + pvMatrixInv[5] * shoot_pos.y + pvMatrixInv[ 9] + pvMatrixInv[13];
                    let wz = pvMatrixInv[2] * shoot_pos.x + pvMatrixInv[6] * shoot_pos.y + pvMatrixInv[10] + pvMatrixInv[14];
                    let ww = pvMatrixInv[3] * shoot_pos.x + pvMatrixInv[7] * shoot_pos.y + pvMatrixInv[11] + pvMatrixInv[15];
                    wx /= ww;
                    wy /= ww;
                    wz /= ww;
                    // 平面と視線の交差判定 (wpos + (camera_pos-wpos) t - (0,0,0)).(0,1,0) = 0 => t = -(camera_pos.y-wpos.y)/wpos.y
                    let t = - camera_pos[1] / wy + 1.0;
                    wx = wx + (camera_pos[0] - wx) * t;// ワールド空間での交点
                    wz = wz + (camera_pos[2] - wz) * t;
                    wx = wx / WATER_SIZE + 0.5;// シェーダでの取り扱いを合わせるため[0,1]の範囲に修正
                    wz = wz / WATER_SIZE + 0.5;
                    gl.uniform2f(program_water.loc[2], wx, wz);// 'bullet_pos'
                }else{
                    // 遠くの場所を指定することで盛り上げる処理を無効化
                    gl.uniform2f(program_water.loc[2], -10.0, -10.0);// 'bullet_pos'
                }
                gl.bindVertexArray(mesh_full_screen.vao);// 頂点データを設定して描画
                gl.drawElements(gl.TRIANGLES, mesh_full_screen.count, gl.UNSIGNED_SHORT, 0);

                // 元に戻す
                gl.enable(gl.DEPTH_TEST);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                gl.viewport(0.0, 0.0, canvas.width, canvas.height);
            }
            
            ////////////////////////////
            // 浮動小数点数バッファへの作成
            gl.bindFramebuffer(gl.FRAMEBUFFER, floatBuffer.f);
            gl.viewport(0.0, 0.0, canvas.width, canvas.height);

            // オブジェクト描画
            if(envMap.tex){// キューブマップが読み込まれた後
                // 背景描画(背景のクリアを含む)
                gl.depthFunc(gl.ALWAYS);// テストを常に成功させて強制的に書き込む
                gl.useProgram(program_bg.prg);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_CUBE_MAP, envMap.tex);
                gl.uniform1i(program_bg.loc[0], 0); // 'sampCube'
                gl.uniformMatrix4fv(program_bg.loc[1], false, pvMatrixInv);// 'pvMatrixInv'
                gl.uniform3f(program_bg.loc[2], camera_pos[0], camera_pos[1], camera_pos[2]);// 'camera_pos'
                gl.bindVertexArray(mesh_full_screen.vao);
                gl.drawElements(gl.TRIANGLES, mesh_full_screen.count, gl.UNSIGNED_SHORT, 0);
                gl.depthFunc(gl.LEQUAL);// 通常のテストに戻す
                
                // シーンの描画
                gl.useProgram(program_scene.prg);
                gl.uniformMatrix4fv(program_scene.loc[1], false, pvMatrix); // 'pvMatrix'
                gl.uniform3f(program_scene.loc[2], camera_pos[0], camera_pos[1], camera_pos[2]); // 'camera_pos'
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_CUBE_MAP, envMap.tex);
                gl.uniform1i(program_scene.loc[3], 0);// 'sampCube'
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, heightMap[heightmap_idx].t);
                gl.uniform1i(program_scene.loc[4], 1);// 'samp'
                draw_mesh(program_scene, wMatrixWater,  mesh_water); // 水面
            }
            
            ////////////////////////////
            // トーンマッピングと逆ガンマ補正
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);// 通常のフレームバッファに戻す
            gl.viewport(0.0, 0.0, canvas.width, canvas.height);
            
            gl.disable(gl.DEPTH_TEST);// テストは無効
            gl.useProgram(program_post.prg);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, floatBuffer.t);
            gl.uniform1i(program_post.loc[0], 0); // 'samp'
            gl.bindVertexArray(mesh_full_screen.vao);
            gl.drawElements(gl.TRIANGLES, mesh_full_screen.count, gl.UNSIGNED_SHORT, 0);
            gl.enable(gl.DEPTH_TEST);// テストを戻す
            

            ////////////////////////////
            // デバッグ描画
            gl.useProgram(program_debug.prg);
            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(program_debug.loc[1], 0); // 'samp'
            gl.bindTexture(gl.TEXTURE_2D, heightMap[heightmap_idx].t);
            draw_mesh(program_debug, mat.identity(mat.create()),  mesh_debug_plane);
            
            ////////////////////////////
            // 次のフレームへの処理
            ////////////////////////////
            gl.useProgram(null);
            gl.flush();
            window.requestAnimationFrame(update);
        }
        
    }, false);

    // シェーダの読み込み
    function load_shader(src, type)
    {
        let shader = gl.createShader(type);
        gl.shaderSource(shader, src);
        gl.compileShader(shader);
        if(!gl.getShaderParameter(shader, gl.COMPILE_STATUS)){
            alert(gl.getShaderInfoLog(shader));
        }
        return shader;
    }

    // プログラムオブジェクトの生成
    function create_program(vsSource, fsSource, uniform_names)
    {
        let prg = gl.createProgram();
        gl.attachShader(prg, load_shader(vsSource, gl.VERTEX_SHADER));
        gl.attachShader(prg, load_shader(fsSource, gl.FRAGMENT_SHADER));
        gl.linkProgram(prg);
        if(!gl.getProgramParameter(prg, gl.LINK_STATUS)){
            alert(gl.getProgramInfoLog(prg));
        }

        let uniLocations = [];
        uniform_names.forEach(function(value){
            uniLocations.push(gl.getUniformLocation(prg, value));
        });
        
        return {prg : prg, loc : uniLocations};
    }

    // テクスチャの読み込み
    function create_texture(src, dest)
    {
        // インスタンス用の配列
        let img;
        
        img = new loadImage();
        img.data.src = src; // ファイル名を指定
        
        // 画像のコンストラクタ
        function loadImage()
        {
            this.data = new Image();
            
            // 読み込まれた後の処理
            this.data.onload = function(){
                let tex = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, tex);// キューブマップとしてバインド
                    
                let width = img.data.width;
                let height = img.data.height;
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
                
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                // テクスチャのバインドを無効化
                gl.bindTexture(gl.TEXTURE_2D, null);
                
                dest.tex = tex;
            };
        }
    }

    // キューブマップの読み込み
    function create_cube_texture(sources, dest)
    {
        // インスタンス用の配列
        let a_img = new Array();
        
        for(let i = 0; i < 6; i++){
            a_img[i] = new cubeMapImage();
            a_img[i].data.src = sources[i]; // ファイル名を指定
        }
        
        // キューブマップ用画像のコンストラクタ
        function cubeMapImage()
        {
            this.data = new HDRImage();
            
            // 読み込まれた後の処理
            this.data.onload = function(){
                this.isLoaded = true; // 読み込んだフラグ
                
                // 全ての画像を読み込んだらキューブマップを生成
                if( a_img[0].data.isLoaded &&
                    a_img[1].data.isLoaded &&
                    a_img[2].data.isLoaded &&
                    a_img[3].data.isLoaded &&
                    a_img[4].data.isLoaded &&
                    a_img[5].data.isLoaded)
                {
                    let tex = gl.createTexture();
                    gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);// キューブマップとしてバインド
                    
                    let width = a_img[0].data.width;
                    let height = a_img[0].data.height;
                    gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X, 0, gl.RGB32F, width, height, 0, gl.RGB, gl.FLOAT, a_img[0].data.dataFloat);
                    gl.texImage2D(gl.TEXTURE_CUBE_MAP_NEGATIVE_X, 0, gl.RGB32F, width, height, 0, gl.RGB, gl.FLOAT, a_img[1].data.dataFloat);
                    gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_Y, 0, gl.RGB32F, width, height, 0, gl.RGB, gl.FLOAT, a_img[2].data.dataFloat);
                    gl.texImage2D(gl.TEXTURE_CUBE_MAP_NEGATIVE_Y, 0, gl.RGB32F, width, height, 0, gl.RGB, gl.FLOAT, a_img[3].data.dataFloat);
                    gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_Z, 0, gl.RGB32F, width, height, 0, gl.RGB, gl.FLOAT, a_img[4].data.dataFloat);
                    gl.texImage2D(gl.TEXTURE_CUBE_MAP_NEGATIVE_Z, 0, gl.RGB32F, width, height, 0, gl.RGB, gl.FLOAT, a_img[5].data.dataFloat);
                    
                    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                    
                    // テクスチャのバインドを無効化
                    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
                    
                    dest.tex = tex;
                }
            };
        }
    }

    // モデル描画
    function draw_mesh(program, wMatrix, mesh)
    {
        gl.uniformMatrix4fv(program.loc[0], false, wMatrix);// ワールド行列
        gl.bindVertexArray(mesh.vao);
        gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);// 16ビット整数
    }
    
    // インデックス付き三角形リストの生成
    function createMesh(gl, program, vertex_data, index_data) {
        let vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        // 頂点バッファ
        const vertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertex_data), gl.STATIC_DRAW);

        let posAttr = gl.getAttribLocation(program, 'position');
        gl.enableVertexAttribArray(posAttr);
        gl.vertexAttribPointer(posAttr, 3, gl.FLOAT, false, 4*5, 4*0);

        let uvAttr = gl.getAttribLocation(program, 'uv');
        gl.enableVertexAttribArray(uvAttr);
        gl.vertexAttribPointer(uvAttr, 2, gl.FLOAT, false, 4*5, 4*3);

        // インデックスバッファ
        let indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(index_data), gl.STATIC_DRAW);// 16ビット整数

        gl.bindVertexArray(null);

        return {vao : vao, count : index_data.length};
    };

    // フレームバッファの生成(3成分float, float深度バッファ付き)
    function create_framebuffer(width, height){
        // フレームバッファ
        let frameBuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer);
        
        // 深度バッファ
        let depthBuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, width, height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
        
        // 書き出し用テクスチャ
        let texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST );// floatだとバイリニア不可
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        
        // 各種オブジェクトを解除
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        
        // フレームバッファとテクスチャを返す
        return {f : frameBuffer, t : texture};
    }
    
    // レンダーターゲットの生成(2成分float, float深度バッファなし)
    function create_rendertarget(width, height){
        // フレームバッファ
        let frameBuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer);
        
        // 深度バッファ
//        let depthBuffer = gl.createRenderbuffer();
//        gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
//        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, width, height);
//        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
        
        // 書き出し用テクスチャ
        let texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, width, height, 0, gl.RG, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST );// floatだとバイリニア不可
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);// はみ出したら端の値を使う
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        
        // 各種オブジェクトを解除
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        
        // フレームバッファとテクスチャを返す
        return {f : frameBuffer, t : texture};
    }
})();
