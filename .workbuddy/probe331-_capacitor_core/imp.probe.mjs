import("@capacitor/core").then(()=>console.log('IMPORT_OK')).catch((e)=>{console.log('IMPORT_FAIL '+e.message);process.exitCode=3;});
