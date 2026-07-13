codeunit 50920 "Insert Delete Loop Patterns"
{
    procedure InsertInLoop()
    var
        SalesLine: Record "Sales Line";
        i: Integer;
    begin
        for i := 1 to 10 do begin
            SalesLine.Init();
            SalesLine.Insert();
        end;
    end;

    procedure InsertInLoopTemp()
    var
        TempLine: Record "Sales Line" temporary;
        i: Integer;
    begin
        for i := 1 to 10 do begin
            TempLine.Init();
            TempLine.Insert();
        end;
    end;

    procedure DeleteInLoop()
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.SetRange("Document No.", 'TEST');
        if SalesLine.FindSet() then
            repeat
                SalesLine.Delete();
            until SalesLine.Next() = 0;
    end;

    procedure DeleteInLoopTemp()
    var
        TempLine: Record "Sales Line" temporary;
    begin
        TempLine.FindSet();
        repeat
            TempLine.Delete();
        until TempLine.Next() = 0;
    end;

    procedure DeleteAllInLoop()
    var
        SalesLine: Record "Sales Line";
        i: Integer;
    begin
        for i := 1 to 10 do begin
            SalesLine.SetRange("Document No.", Format(i));
            SalesLine.DeleteAll();
        end;
    end;

    procedure ModifyAndInsertInLoop()
    var
        SalesLine: Record "Sales Line";
        NewLine: Record "Sales Line";
        OldLine: Record "Sales Line";
    begin
        SalesLine.SetRange("Document No.", 'TEST');
        if SalesLine.FindSet() then
            repeat
                SalesLine.Modify();
                NewLine.Insert();
                OldLine.Delete();
            until SalesLine.Next() = 0;
    end;

    procedure InsertOnNonRecordInLoop()
    var
        Names: List of [Text];
        i: Integer;
    begin
        // Insert() is a real method on List of [Text] too -- RECORD_OPS
        // (indexer.ts) matches the method NAME only, so this must never read
        // as a SQL INSERT. Names resolves in this procedure's own
        // var_section with isRecord = false, so the record-op detectors must
        // exclude it (whole-branch review Blocker 1).
        for i := 1 to 10 do
            Names.Insert(i, 'x');
    end;
}
