codeunit 50100 "Foo"
{
    /// <summary>
    /// Procedure with a Rec.Modify() inside a repeat...until loop — triggers db-op-in-loop.
    /// </summary>
    procedure ProcessRecords()
    var
        Rec: Record "Customer";
    begin
        if Rec.FindSet() then
            repeat
                Rec.Validate(Name, 'Updated');
                Rec.Modify();
            until Rec.Next() = 0;
    end;

    /// <summary>
    /// Clean procedure — no problematic patterns.
    /// </summary>
    procedure CleanProcedure()
    begin
        Message('Hello from FusionMinimal');
    end;

    /// <summary>
    /// Overloaded procedure name (first variant — no parameters).
    /// </summary>
    procedure OverloadedProc()
    begin
        Message('Overload 1');
    end;

    /// <summary>
    /// Overloaded procedure name (second variant — with a parameter).
    /// </summary>
    procedure OverloadedProc(Input: Text)
    begin
        Message('Overload 2: ' + Input);
    end;
}
